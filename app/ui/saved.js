// Saved: favorites with notes, imported GPX/GeoJSON routes, export, delete, offline areas and settings.
// Everything lives in this browser's IndexedDB (skintrack-data/saved). Nothing personal leaves the device.
import {CONFIG} from '../config.js';
import {el, kv, toast} from './dom.js';
import * as store from '../offline/store.js';
import {ImportError, parseRouteFile, toGeojson, toGpx} from '../lib/validate.js';
import {cleanText} from '../lib/escape.js';
import {geojsonBbox, lineLengthM} from '../lib/geo.js';
import {fmtDistance} from '../lib/units.js';
import {fmtDateTime} from '../lib/time.js';
import {renderOffline} from './offline.js';

const favId = p => `fav:${p.lat.toFixed(5)},${p.lon.toFixed(5)}`;
let cache = null;
async function items() {
  cache ||= store.all('saved').catch(() => []);
  return cache;
}
const invalidate = () => { cache = null; refreshUserLayer().catch(err => console.warn('saved items layer:', err.message)); };

let favSet = new Set();
export const isFavorite = p => !!p && favSet.has(favId(p));
async function refreshFavSet() { favSet = new Set((await items()).filter(x => x.type === 'favorite').map(x => x.id)); }

/** Toggle a favorite for a place. Returns true when it is now saved. */
export async function toggleFavorite(p) {
  const id = favId(p);
  if ((await items()).find(x => x.id === id)) { await store.del('saved', id); invalidate(); await refreshFavSet(); return false; }
  await store.put('saved', {id, type: 'favorite', name: cleanText(p.name || `Point ${p.lat.toFixed(4)}, ${p.lon.toFixed(4)}`, CONFIG.imports.maxNameLength),
    note: '', lon: p.lon, lat: p.lat, createdAt: new Date().toISOString()});
  invalidate(); await refreshFavSet();
  return true;
}

/** Search entries for saved items: [{name, lon, lat}]. */
export async function savedItems() {
  return (await items()).map(x => (x.type === 'favorite' ? {name: x.name, lon: x.lon, lat: x.lat}
    : {name: x.name, lon: (x.bbox[0] + x.bbox[2]) / 2, lat: (x.bbox[1] + x.bbox[3]) / 2}));
}

/* ---------- map layer for imported routes and favorites ---------- */
let mapRef = null;
async function refreshUserLayer() {
  const map = mapRef;
  if (!map) return;
  const list = await items();
  const features = list.flatMap(x => (x.type === 'route' ? x.geojson.features.map(f => ({...f, properties: {...f.properties, savedId: x.id}}))
    : [{type: 'Feature', properties: {name: x.name, savedId: x.id}, geometry: {type: 'Point', coordinates: [x.lon, x.lat]}}]));
  const data = {type: 'FeatureCollection', features};
  if (map.getSource('user')) { map.getSource('user').setData(data); return; }
  map.addSource('user', {type: 'geojson', data});
  map.addLayer({id: 'user-line', type: 'line', source: 'user', filter: ['!=', ['geometry-type'], 'Point'], paint: {'line-color': '#e0245e', 'line-width': 3, 'line-dasharray': [2, 1]}}, 'anchor-overlay');
  map.addLayer({id: 'user-point', type: 'circle', source: 'user', filter: ['==', ['geometry-type'], 'Point'], paint: {'circle-radius': 6, 'circle-color': '#e0245e', 'circle-stroke-color': '#fff', 'circle-stroke-width': 2}}, 'anchor-overlay');
}
export async function initSaved(map) { mapRef = map; await refreshFavSet(); await refreshUserLayer(); }

/* ---------- import / export ---------- */
async function importFile(file, rerender) {
  if (file.size > CONFIG.imports.maxBytes) { toast(`File is larger than ${Math.round(CONFIG.imports.maxBytes / 1048576)} MB.`); return; }
  try {
    const fc = parseRouteFile(file.name, await file.text(), CONFIG.imports);
    const name = cleanText(fc.features.find(f => f.properties.name)?.properties.name || file.name, CONFIG.imports.maxNameLength);
    await store.put('saved', {id: `route:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`, type: 'route', name, note: '',
      fileName: cleanText(file.name, 120), geojson: fc, bbox: geojsonBbox(fc), createdAt: new Date().toISOString()});
    invalidate();
    toast(`Imported ${fc.features.length} feature${fc.features.length === 1 ? '' : 's'} (kept on this device only)`);
    rerender();
  } catch (err) {
    toast(err instanceof ImportError ? `Import failed: ${err.message}` : `Import failed: ${err.message || err}`, 6000);
  }
}

function download(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], {type}));
  const a = el('a', {href: url, download: name});
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
const featuresOf = x => (x.type === 'route' ? x.geojson.features
  : [{type: 'Feature', properties: {name: x.name, description: x.note}, geometry: {type: 'Point', coordinates: [x.lon, x.lat]}}]);
const safeName = s => (s || 'skintrack').replace(/[^\w.-]+/g, '_').slice(0, 60);

function exportButtons(list, base) {
  const feats = () => list.flatMap(featuresOf);
  return el('div', {class: 'row'},
    el('button', {class: 'btn', type: 'button', onclick: () => download(`${safeName(base)}.gpx`, toGpx(feats()), 'application/gpx+xml')}, 'Export GPX'),
    el('button', {class: 'btn', type: 'button', onclick: () => download(`${safeName(base)}.geojson`, toGeojson(feats()), 'application/geo+json')}, 'Export GeoJSON'));
}

/* ---------- rendering ---------- */
function itemCard(x, {select, rerender}) {
  const len = x.type === 'route' ? x.geojson.features.reduce((s, f) => s + (f.geometry.type === 'LineString' ? lineLengthM(f.geometry.coordinates) : 0), 0) : null;
  const note = el('textarea', {'aria-label': `Note for ${x.name}`, maxlength: String(CONFIG.imports.maxNoteLength), placeholder: 'Private note (stays on this device)'});
  note.value = x.note || '';
  note.addEventListener('change', async () => { await store.put('saved', {...x, note: cleanText(note.value, CONFIG.imports.maxNoteLength)}); invalidate(); toast('Note saved'); });
  const go = () => {
    if (x.type === 'route') select({lon: (x.bbox[0] + x.bbox[2]) / 2, lat: (x.bbox[1] + x.bbox[3]) / 2, name: x.name, bbox: x.bbox});
    else select({lon: x.lon, lat: x.lat, name: x.name});
  };
  return el('div', {class: 'card'},
    el('h4', {}, x.name, ' ', el('span', {class: 'badge'}, x.type === 'route' ? 'Imported route' : 'Saved place')),
    kv([['Added', fmtDateTime(x.createdAt)], ['File', x.fileName], ['Features', x.type === 'route' ? String(x.geojson.features.length) : null], ['Line length', len ? fmtDistance(len) : null]]),
    note,
    el('div', {class: 'row', style: 'margin-top:8px'}, el('button', {class: 'btn primary', type: 'button', onclick: go}, 'Show on map'),
      exportButtons([x], x.name),
      el('button', {class: 'btn danger', type: 'button', onclick: async () => {
        if (!confirm(`Delete "${x.name}" from this device?`)) return;
        await store.del('saved', x.id); invalidate(); await refreshFavSet(); rerender();
      }}, 'Delete')));
}

/** Render the Saved view. */
export function renderSaved(ctx, {map, select, openSources}) {
  const root = el('div', {});
  const rerender = () => { root.replaceChildren(...build()); fill(); };
  const listBox = el('div', {}, el('p', {class: 'muted'}, 'Loading…'));
  const fileInput = el('input', {type: 'file', accept: '.gpx,.geojson,.json,application/gpx+xml,application/geo+json,application/json', class: 'visually-hidden',
    onchange: e => { const f = e.target.files?.[0]; if (f) importFile(f, rerender); e.target.value = ''; }});
  const build = () => [
    el('section', {class: 'section'}, el('h3', {}, 'Your places and routes'),
      el('p', {class: 'small muted'}, 'Stored only in this browser. Nothing is uploaded. Clearing site data removes it.'),
      el('div', {class: 'row', style: 'margin-bottom:10px'}, el('label', {class: 'btn primary'}, 'Import GPX or GeoJSON', fileInput)),
      listBox),
    el('section', {class: 'section'}, el('h3', {}, 'Offline areas'), renderOffline(ctx, {map})),
    el('section', {class: 'section'}, el('h3', {}, 'About'),
      el('div', {class: 'row'}, el('button', {class: 'btn', type: 'button', onclick: openSources}, 'Sources and methods')),
      el('p', {class: 'small muted'}, `${CONFIG.appName} ${CONFIG.version}. Personal, non-commercial map. Terrain and model layers describe terrain only and never say whether a slope is safe.`))];
  async function fill() {
    cache = null;
    const list = (await items()).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    listBox.replaceChildren(...(list.length ? [exportButtons(list, 'skintrack-all'), ...list.map(x => itemCard(x, {select, rerender}))]
      : [el('p', {class: 'empty-state'}, 'Nothing saved yet. Select a point and tap Save, or import a GPX or GeoJSON file.')]));
  }
  root.append(...build());
  fill();
  return root;
}
