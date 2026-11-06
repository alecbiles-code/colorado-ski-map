// Shared helpers for overlay layer modules: find products in the manifest and add them as map sources
// through the one tile path (PMTiles raster or vector) or as GeoJSON fetched once.
import {fetchJson} from '../lib/net.js';
import {registerPmtiles} from '../map/tiles.js';
import {safeUrl} from '../lib/escape.js';

/** First manifest product matching test, or undefined. */
export const product = (ctx, test) => ctx.products.find(test);
/** Site-relative URL for a product file. */
export const dataUrl = url => (/^[a-z]+:\/\//i.test(url) ? url : `./${String(url).replace(/^\.\//, '')}`);

const geojsonCache = new Map();
/** Fetch a GeoJSON file once and keep the parsed object (also used by the inspector for full properties). */
export function loadGeojson(url) {
  if (!geojsonCache.has(url)) geojsonCache.set(url, fetchJson(dataUrl(url)).catch(e => { geojsonCache.delete(url); throw e; }));
  return geojsonCache.get(url);
}

/** Add a GeoJSON source if missing. Returns the parsed data. */
export async function addGeojson(map, id, url) {
  const data = await loadGeojson(url);
  if (!map.getSource(id)) map.addSource(id, {type: 'geojson', data, promoteId: 'id'});
  return data;
}

/**
 * Add a product as a map source. PMTiles go through skt:// (offline first); GeoJSON is fetched.
 * Returns {kind: 'raster'|'vector'|'geojson', sourceLayer}.
 */
export async function addProductSource(map, id, p, meta) {
  if (map.getSource(id)) return map.getSource(id).__skt;
  const url = meta.url || p.url;
  let out;
  if (/\.pmtiles$/i.test(url)) {
    const raster = /png|webp|jpg|raster/i.test(`${meta.tileType || ''} ${meta.format || ''} ${meta.kind || ''}`);
    const minzoom = meta.minzoom ?? 0; const maxzoom = meta.maxzoom ?? 14;
    registerPmtiles(id, [{url, minzoom, maxzoom, bounds: meta.bbox}], {tileType: raster ? 'raster' : 'vector'});
    const src = {type: raster ? 'raster' : 'vector', tiles: [`skt://tile/${id}/{z}/{x}/{y}`], minzoom, maxzoom, ...(meta.bbox ? {bounds: meta.bbox} : {})};
    if (raster) src.tileSize = meta.tileSize || 256;
    map.addSource(id, src);
    out = {kind: src.type, sourceLayer: meta.sourceLayer || meta.vectorLayers?.[0]?.id || meta.vector_layers?.[0]?.id || id};
  } else {
    await addGeojson(map, id, url);
    out = {kind: 'geojson', sourceLayer: undefined};
  }
  map.getSource(id).__skt = out;
  return out;
}

/** Attribution and license lines from a meta file's sources list. */
export function metaInfo(meta, extra = {}) {
  const sources = (meta?.sources || []).map(s => `${s.name || 'Source'}${s.license ? ` (${s.license})` : ''}`);
  return {
    text: [extra.text, sources.length ? `Sources: ${sources.join('; ')}.` : ''].filter(Boolean).join(' '),
    notes: [...(meta?.limitations || []), ...(extra.notes || [])],
    links: [...(meta?.sources || []).map(s => [s.name || 'Source', safeUrl(s.landingPage || s.url || s.docs)]).filter(([, u]) => u), ...(extra.links || [])],
    metaUrl: extra.metaUrl
  };
}

/** Feature property helper that tolerates MapLibre's stringified nested values. */
export const prop = (f, k) => {
  const v = f.properties?.[k];
  return v === undefined || v === null || v === '' ? null : v;
};
