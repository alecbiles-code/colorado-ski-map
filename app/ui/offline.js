// Offline areas UI: pick an area (current view or a drawn box), see layers, zooms and estimated size,
// download with progress and cancel, then see what was actually stored. Resume, update and delete.
import {CONFIG} from '../config.js';
import {el, kv, toast} from './dom.js';
import {fmtBytes, numericKeys, planPackage} from '../offline/planner.js';
import {deletePackage, downloadPackage, listPackages, requestPersist, storageInfo} from '../offline/packages.js';
import {getSet} from '../map/tiles.js';
import {tier2Info, DEM} from '../map/terrain.js';
import {numericCellAt} from '../lib/terrain-math.js';
import {fmtDateTime} from '../lib/time.js';
import {bboxIntersects} from '../lib/geo.js';

let running = null; // {ctl, id}

/** Tile sets this package may store. Only self-hosted, open-data or our own static products. */
function candidateSets(ctx, bbox) {
  const avg = CONFIG.offline.avgTileBytes;
  const sets = [];
  const bm = getSet('basemap');
  if (bm) sets.push({id: 'basemap', label: 'Basemap (OpenStreetMap via Protomaps)', minzoom: 0, maxzoom: bm.maxzoom, avgBytes: avg.basemap});
  sets.push({id: 'dem', label: `Terrain (${DEM.name}): hillshade, contours, Tier 1 slope and aspect`, minzoom: 0, maxzoom: DEM.maxzoom, avgBytes: avg.dem});
  const km = Math.max(bbox[2] - bbox[0], bbox[3] - bbox[1]) * 111;
  for (const r of tier2Info()?.regions || []) {
    if (!bboxIntersects(r.bbox, bbox)) continue;
    sets.push({id: r.setId, label: `Tier 2 terrain numbers, 10 m (${r.id})`,
      keys: numericKeys(bbox, (lon, lat) => numericCellAt(lon, lat, r.num), Math.min(400, Math.ceil(km))), avgBytes: avg.t2num});
  }
  for (const d of ctx.reg.visible()) {
    for (const src of d.sources || []) {
      const s = getSet(src);
      if (!s || src === 'basemap' || src === 'dem' || sets.some(x => x.id === src)) continue;
      sets.push({id: src, label: `${d.title} tiles`, minzoom: s.minzoom, maxzoom: s.maxzoom, bounds: s.archives?.[0]?.bounds, avgBytes: avg.overlay});
    }
  }
  return sets;
}

/** Static files the package caches: manifest, every meta, and all GeoJSON products. Returns {urls, bytes}. */
function dataFiles(ctx) {
  const base = new URL('.', document.baseURI).href;
  const urls = new Set([new URL(CONFIG.manifestUrl, base).href, new URL(CONFIG.basemap.metaUrl, base).href, new URL(CONFIG.incidentLinksUrl, base).href,
    `${base}data/sar/coverage.geojson`]);
  let bytes = 0;
  for (const p of ctx.products) {
    urls.add(base + p.meta);
    if (p.url && /\.(geo)?json$/.test(p.url)) { urls.add(base + p.url); bytes += p.bytes || 0; }
  }
  return {urls: [...urls], bytes};
}

function boxLayer(map, bbox) {
  const data = {type: 'Feature', properties: {}, geometry: {type: 'Polygon', coordinates: [[[bbox[0], bbox[1]], [bbox[2], bbox[1]], [bbox[2], bbox[3]], [bbox[0], bbox[3]], [bbox[0], bbox[1]]]]}};
  if (map.getSource('offline-box')) return map.getSource('offline-box').setData(data);
  map.addSource('offline-box', {type: 'geojson', data});
  map.addLayer({id: 'offline-box', type: 'line', source: 'offline-box', paint: {'line-color': '#e0245e', 'line-width': 3, 'line-dasharray': [2, 2]}});
}
const viewBbox = map => { const b = map.getBounds(); return [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()].map(v => Number(v.toFixed(5))); };

function packageCard(p, {map, rerender, start}) {
  const pct = p.plan.tiles ? Math.round((100 * (p.stored?.tiles ?? 0)) / p.plan.tiles) : 0;
  const badge = p.status === 'complete' ? 'ok' : 'warn';
  return el('div', {class: 'card'},
    el('h4', {}, p.name, ' ', el('span', {class: `badge ${badge}`}, p.status === 'complete' ? 'Complete' : p.status === 'downloading' ? 'Downloading' : `${p.status === 'interrupted' ? 'Interrupted' : 'Partial'} (${pct}%)`)),
    kv([['Bounds', p.bbox.map(v => v.toFixed(3)).join(', ')], ['Layers', p.layers.join('; ')], ['Zooms', `0 to ${p.plan.maxzoom}`],
      ['Downloaded', fmtDateTime(p.finishedAt || p.startedAt)], ['Stored', p.stored ? `${p.stored.tiles} of ${p.plan.tiles} tiles, ${fmtBytes(p.stored.bytes)}` : 'n/a'],
      ['Failed', p.failedTiles || p.failedFiles?.length ? `${p.failedTiles || 0} tiles, ${p.failedFiles?.length || 0} files` : null],
      ['Data as of', (p.sourceTimestamps || []).join('; ')], ['Package version', String(p.version)], ['Error', p.error]]),
    el('div', {class: 'row'},
      el('button', {class: 'btn', type: 'button', onclick: () => { map.fitBounds([[p.bbox[0], p.bbox[1]], [p.bbox[2], p.bbox[3]]], {padding: 30}); boxLayer(map, p.bbox); }}, 'Show area'),
      p.status !== 'complete' ? el('button', {class: 'btn primary', type: 'button', onclick: () => start(p)}, 'Resume') : null,
      el('button', {class: 'btn', type: 'button', onclick: () => start({...p, id: `pkg-${Date.now()}`, replaces: p.id, startedAt: null, stored: null})}, 'Update'),
      el('button', {class: 'btn danger', type: 'button', onclick: async () => {
        if (!confirm(`Delete offline area "${p.name}"?`)) return;
        await deletePackage(p.id); toast('Offline area deleted'); rerender();
      }}, 'Delete')));
}

/** Render the offline section (lives inside Saved). */
export function renderOffline(ctx, {map}) {
  const root = el('div', {});
  let bbox = viewBbox(map);
  let maxzoom = CONFIG.offline.defaultMaxZoom;
  const estimate = el('div', {});
  const progress = el('div', {});
  const list = el('div', {});
  const storage = el('p', {class: 'small muted'});

  function plan() {
    const sets = candidateSets(ctx, bbox);
    return {sets, plan: planPackage(bbox, maxzoom, sets)};
  }
  function showEstimate() {
    const {sets, plan: pl} = plan();
    const files = dataFiles(ctx);
    const tooBig = pl.tiles > CONFIG.offline.maxTiles;
    estimate.replaceChildren(
      kv([['Area', bbox.map(v => v.toFixed(3)).join(', ')], ['Zooms', `0 to ${maxzoom}`], ['Tiles', pl.tiles.toLocaleString()],
        ['Estimated size', `about ${fmtBytes(pl.estBytes + files.bytes)} (estimate; the result shows what was actually stored)`]]),
      el('ul', {class: 'small'}, pl.sets.map(s => el('li', {}, `${sets.find(x => x.id === s.id).label}: ${s.tiles.toLocaleString()} tiles`)),
        el('li', {}, `Data files (statewide routes, places, stations, land status, metadata): ${files.urls.length} files, ${fmtBytes(files.bytes)}`)),
      el('p', {class: 'small muted'}, 'Not stored: live forecasts, weather and SNOTEL readings (online only; the Conditions view keeps its own last-good copy with its age), SNODAS, and layers that are off. Turn a layer on first to include its tiles.'),
      tooBig ? el('p', {class: 'note'}, `Too many tiles (limit ${CONFIG.offline.maxTiles.toLocaleString()}). Zoom in or lower the maximum zoom.`) : null,
      el('button', {class: 'btn primary block', type: 'button', disabled: tooBig || !!running, onclick: () => {
        const name = `Area ${new Date().toLocaleDateString('en-US', {month: 'short', day: 'numeric'})} (${bbox[1].toFixed(2)}, ${bbox[0].toFixed(2)})`;
        start({id: `pkg-${Date.now()}`, name, bbox, plan: pl, layers: pl.sets.map(s => sets.find(x => x.id === s.id).label)});
      }}, 'Download this area'));
  }

  async function start(pkg) {
    if (running) return toast('A download is already running');
    // A new download or an update records today's products; a resume keeps what it started with.
    if (!pkg.startedAt) pkg = {...pkg, files: dataFiles(ctx).urls,
      sourceTimestamps: ctx.products.map(p => p.processedAt && `${p.id} ${p.processedAt.slice(0, 10)}`).filter(Boolean)};
    const ctl = new AbortController();
    running = {ctl, id: pkg.id};
    requestPersist().catch(() => {});
    const bar = el('progress', {max: String(pkg.plan.tiles), value: '0'});
    const label = el('p', {class: 'small'}, 'Starting…');
    progress.replaceChildren(el('div', {class: 'card'}, el('h4', {}, `Downloading ${pkg.name}`), bar, label,
      el('button', {class: 'btn danger', type: 'button', onclick: () => ctl.abort()}, 'Cancel')));
    try {
      const rec = await downloadPackage(pkg, {signal: ctl.signal, onProgress: ({done, total, failed}) => {
        bar.value = done; label.textContent = `${done.toLocaleString()} of ${total.toLocaleString()} tiles${failed ? `, ${failed} failed` : ''}`;
      }});
      const msg = rec.status === 'complete' ? `Complete: ${rec.stored.tiles} tiles, ${fmtBytes(rec.stored.bytes)} stored and verified.`
        : `${rec.status === 'interrupted' ? 'Cancelled' : 'Incomplete'}: ${rec.stored.tiles} of ${rec.plan.tiles} tiles stored. Resume to finish.`;
      progress.replaceChildren(el('p', {class: rec.status === 'complete' ? 'small' : 'note'}, msg));
    } catch (err) {
      progress.replaceChildren(el('p', {class: 'note'}, `Download stopped: ${err.name === 'QuotaExceededError' ? 'browser storage is full' : err.message}.`));
    } finally { running = null; refreshList(); showEstimate(); }
  }

  async function refreshList() {
    const pkgs = (await listPackages().catch(() => [])).sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
    list.replaceChildren(...(pkgs.length ? pkgs.map(p => packageCard(p, {map, rerender: refreshList, start})) : [el('p', {class: 'empty-state'}, 'No offline areas yet.')]));
    const s = await storageInfo();
    storage.textContent = `Browser storage: ${s.usage === null ? 'unknown' : fmtBytes(s.usage)} used of ${s.quota === null ? 'unknown' : fmtBytes(s.quota)}. ` +
      (s.persisted ? 'Persistent storage granted.' : 'Not marked persistent: the browser may evict it under storage pressure (iOS can after weeks without use).');
  }

  const zoomSeg = el('div', {class: 'seg', role: 'group', 'aria-label': 'Maximum zoom'}, [12, 13, 14].map(z => el('button', {type: 'button', 'aria-pressed': String(z === maxzoom),
    onclick: e => { maxzoom = z; zoomSeg.querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', String(b === e.currentTarget))); showEstimate(); }}, `z${z}`)));
  const drawBtn = el('button', {class: 'btn', type: 'button', onclick: () => {
    const pts = [];
    toast('Tap two opposite corners of the area on the map', 6000);
    ctx.onMapClick = e => {
      pts.push([e.lngLat.lng, e.lngLat.lat]);
      if (pts.length < 2) return;
      ctx.onMapClick = null;
      bbox = [Math.min(pts[0][0], pts[1][0]), Math.min(pts[0][1], pts[1][1]), Math.max(pts[0][0], pts[1][0]), Math.max(pts[0][1], pts[1][1])].map(v => Number(v.toFixed(5)));
      boxLayer(map, bbox); showEstimate(); toast('Box set');
    };
  }}, 'Draw a box');
  root.append(
    el('p', {class: 'small muted'}, 'Stores map, terrain and our static data for an area in this browser so it works without signal. Live forecasts and weather still need a connection.'),
    el('div', {class: 'row', style: 'margin-bottom:8px'}, el('button', {class: 'btn', type: 'button', onclick: () => { bbox = viewBbox(map); boxLayer(map, bbox); showEstimate(); }}, 'Use current view'), drawBtn, zoomSeg),
    estimate, progress, list, storage);
  showEstimate(); refreshList();
  return root;
}
