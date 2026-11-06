// The one tile path. Every tile the map draws (basemap, DEM, computed terrain, pilot products) goes
// through getTile(): offline packages in IndexedDB first, then the network (PMTiles via the pmtiles
// library, XYZ via fetch). MapLibre reaches it through the custom protocol "skt://".
//   skt://tile/<setId>/<z>/<x>/<y>       stored or fetched tile bytes
//   skt://<kind>/<id>/<z>/<x>/<y>         computed tiles from a registered generator (for example terrain)
import {CONFIG} from '../config.js';
import * as store from '../offline/store.js';
import {bboxIntersects, tileBbox} from '../lib/geo.js';

const sets = new Map(); // id -> {kind: 'pmtiles'|'xyz', archives|template, minzoom, maxzoom, tileType}
const generators = new Map(); // kind -> async (id, z, x, y, signal) => ArrayBuffer
let packages = []; // offline index: [{id, sources: [], bbox, minzoom, maxzoom}]

/** Per-set loading and failure counters, observed by the layer panel. */
export const tileEvents = new EventTarget();
const stats = new Map();
function bump(id, field, delta = 1) {
  const s = stats.get(id) || {inflight: 0, ok: 0, failed: 0, offline: 0, lastError: null};
  s[field] += delta;
  stats.set(id, s);
  tileEvents.dispatchEvent(new CustomEvent('change', {detail: {id, stats: s}}));
}
export const tileStats = id => stats.get(id) || {inflight: 0, ok: 0, failed: 0, offline: 0, lastError: null};

// 1x1 transparent PNG, returned for raster tiles that legitimately do not exist.
export const EMPTY_PNG = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='), c => c.charCodeAt(0)).buffer;

/** Resolve a site-relative URL ("data/x" or "./data/x") against the page, keeping {z}-style placeholders. */
export function absUrl(url) {
  if (/^[a-z]+:\/\//i.test(url)) return url;
  return new URL('.', document.baseURI).href + url.replace(/^\.\//, '');
}

/**
 * Register several PMTiles archives as one tile set. By default the first archive with the tile wins.
 * composite: raster archives whose tiles are transparent outside their own region (Tier 2 slope cells);
 * a tile that several archives hold is drawn from all of them, so region seams have no gap.
 */
export function registerPmtiles(id, archives, {tileType = 'vector', composite = false} = {}) {
  const list = archives.map(a => ({...a, pm: null}));
  sets.set(id, {kind: 'pmtiles', archives: list, tileType, composite,
    minzoom: Math.min(...list.map(a => a.minzoom ?? 0)), maxzoom: Math.max(...list.map(a => a.maxzoom ?? 14))});
}

/** Draw several same-size raster tiles over each other (alpha is 0 or 255 in our tiles, so order does not matter). */
async function compositeImages(buffers) {
  const bmps = await Promise.all(buffers.map(b => createImageBitmap(new Blob([b]))));
  const {width, height} = bmps[0];
  const c = typeof OffscreenCanvas === 'function' ? new OffscreenCanvas(width, height)
    : Object.assign(document.createElement('canvas'), {width, height});
  const g = c.getContext('2d');
  for (const b of bmps) g.drawImage(b, 0, 0, width, height);
  const blob = c.convertToBlob ? await c.convertToBlob({type: 'image/png'})
    : await new Promise((resolve, reject) => c.toBlob(b => (b ? resolve(b) : reject(new Error('PNG encoding failed'))), 'image/png'));
  return blob.arrayBuffer();
}

/**
 * Register an XYZ URL template as a tile set. download(z, x, y) may name a PMTiles archive URL that holds the
 * same tiles; offline packages then read from that archive instead of the XYZ endpoint.
 */
export function registerXyz(id, template, {maxzoom = 15, tileType = 'raster', download = null} = {}) {
  sets.set(id, {kind: 'xyz', template, minzoom: 0, maxzoom, tileType, download});
}

const archives = new Map(); // url -> PMTiles instance (shared by download reads)
async function fromArchive(url, z, x, y, signal) {
  if (!archives.has(url)) archives.set(url, new globalThis.pmtiles.PMTiles(url));
  const r = await archives.get(url).getZxy(z, x, y, signal);
  return r?.data || null;
}

export const getSet = id => sets.get(id);
export const registerGenerator = (kind, fn) => generators.set(kind, fn);
export const setOfflineIndex = list => { packages = list; };

/** Look the tile up in stored packages. Returns ArrayBuffer, an empty marker, or undefined. */
async function fromOffline(id, z, x, y) {
  const geo = sets.get(id)?.tileType !== 'numeric'; // numeric tiles use a UTM block key, not Web Mercator
  for (const p of packages) {
    if (!p.sources.includes(id)) continue;
    if (geo && (z < p.minzoom || z > p.maxzoom || !bboxIntersects(p.bbox, tileBbox(z, x, y)))) continue;
    try {
      const v = await store.get('tiles', `${p.id}|${id}/${z}/${x}/${y}`);
      if (v !== undefined) return v;
    } catch { /* storage unavailable: fall through to network */ }
  }
  return undefined;
}

/** fetch() with the configured timeout, an outer abort signal and bounded retries for network errors. */
async function fetchBytes(url, signal, retries = 1) {
  for (let attempt = 0; ; attempt++) {
    const ctl = new AbortController();
    const onAbort = () => ctl.abort();
    signal?.addEventListener('abort', onAbort);
    const timer = setTimeout(() => ctl.abort(), CONFIG.network.timeoutMs);
    try {
      const res = await fetch(url, {signal: ctl.signal});
      if (res.status === 404 || res.status === 204) return null;
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.arrayBuffer();
    } catch (err) {
      if (signal?.aborted || attempt >= retries) throw err;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }
}

/** Fetch from the network: first PMTiles archive covering the tile, or the XYZ template. */
async function fromNetwork(set, z, x, y, signal) {
  if (set.kind === 'xyz') {
    return fetchBytes(set.template.replace('{z}', z).replace('{x}', x).replace('{y}', y), signal);
  }
  const tb = tileBbox(z, x, y);
  let lastErr = null;
  const hits = [];
  for (const a of set.archives) {
    if (z < a.minzoom || z > a.maxzoom || (a.bounds && !bboxIntersects(a.bounds, tb))) continue;
    try {
      a.pm ||= new globalThis.pmtiles.PMTiles(absUrl(a.url));
      const r = await a.pm.getZxy(z, x, y, signal);
      if (r?.data) { if (!set.composite) return r.data; hits.push(r.data); }
    } catch (err) {
      if (signal?.aborted) throw err;
      lastErr = err;
    }
  }
  if (hits.length) return hits.length === 1 ? hits[0] : compositeImages(hits);
  if (lastErr) throw lastErr;
  return null;
}

/**
 * The tile path. Returns {data: ArrayBuffer|null, from: 'offline'|'network'}; data null means the tile
 * legitimately does not exist (outside coverage). Throws on network failure.
 * @param {string} id tile set id
 * @param {{signal?: AbortSignal, offline?: boolean, network?: boolean, download?: boolean}} [opts]
 *   download: read from the set's download archive when it has one (offline packages).
 */
export async function getTile(id, z, x, y, {signal, offline = true, network = true, download = false} = {}) {
  const set = sets.get(id);
  if (!set) throw new Error(`unknown tile set ${id}`);
  if (offline) {
    const v = await fromOffline(id, z, x, y);
    if (v !== undefined) { bump(id, 'offline'); return {data: v && v.byteLength ? v : null, from: 'offline'}; }
  }
  if (!network) return {data: null, from: 'missing'};
  bump(id, 'inflight');
  try {
    const via = download && set.download?.(z, x, y);
    const data = via ? await fromArchive(via, z, x, y, signal) : await fromNetwork(set, z, x, y, signal);
    bump(id, 'ok');
    return {data, from: 'network'};
  } catch (err) {
    if (!signal?.aborted) { const s = tileStats(id); s.lastError = String(err?.message || err); bump(id, 'failed'); }
    throw err;
  } finally {
    bump(id, 'inflight', -1);
  }
}

/** Install the skt:// protocol on MapLibre. */
export function installProtocol(maplibregl) {
  maplibregl.addProtocol('skt', async (params, abort) => {
    const [kind, id, z, x, y] = params.url.slice('skt://'.length).split(/[/?]/);
    const zi = Number(z); const xi = Number(x); const yi = Number(y);
    if (kind === 'tile') {
      const r = await getTile(id, zi, xi, yi, {signal: abort.signal});
      if (r.data) return {data: r.data};
      const type = sets.get(id).tileType;
      // A 1x1 placeholder DEM breaks MapLibre's neighbour backfill ("dem dimension mismatch"); status 404 is its quiet missing tile.
      if (type === 'raster-dem') throw Object.assign(new Error(`No DEM tile ${z}/${x}/${y}`), {status: 404});
      return {data: type === 'vector' ? new ArrayBuffer(0) : EMPTY_PNG};
    }
    const gen = generators.get(kind);
    if (!gen) throw new Error(`no generator for ${kind}`);
    return {data: await gen(id, zi, xi, yi, abort.signal)};
  });
}
