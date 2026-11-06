// Boot, view routing and shared state (selected place, active view). Views render into one sheet.
import {CONFIG} from './config.js';
import {getUnits, setUnits} from './lib/units.js';
import {fetchJson} from './lib/net.js';
import {buildHash, parseHash} from './lib/hash.js';
import {createMap, applyUnitsToMap} from './map/map.js';
import {installTerrain, DEM} from './map/terrain.js';
import {createRegistry} from './map/layers.js';
import {terrainLayers, setupTier2} from './layers/terrain.js';
import {overlayLayers} from './layers/index.js';
import {createSheet} from './ui/sheet.js';
import {el, toast} from './ui/dom.js';
import {renderLayersPanel} from './ui/layers-panel.js';
import {featuresAt, fmtLatLon, renderPlaceCard} from './ui/inspector.js';
import {initSearch} from './ui/search.js';
import {initLocate} from './ui/locate.js';
import {renderExplore} from './ui/explore.js';
import {renderSaved, isFavorite, toggleFavorite, initSaved} from './ui/saved.js';
import {renderSources} from './ui/sources.js';
import {setOfflineIndexFromStore, listPackages} from './offline/packages.js';
import {bboxContains} from './lib/geo.js';

const SEL_KEY = 'skintrack-selection';
const ctx = {config: CONFIG, products: [], metaCache: new Map(), metas: new Map(), conditions: null, view: 'map', selection: null, onMapClick: null};
ctx.meta = id => {
  const p = ctx.products.find(x => x.id === id);
  if (!p) return Promise.reject(new Error(`unknown product ${id}`));
  if (!ctx.metaCache.has(id)) ctx.metaCache.set(id, fetchJson(`./${p.meta}`).catch(e => { ctx.metaCache.delete(id); throw e; }));
  return ctx.metaCache.get(id);
};

async function loadManifest() {
  try { ctx.products = (await fetchJson(CONFIG.manifestUrl)).products || []; } catch (err) {
    console.warn('manifest unavailable:', err.message);
    ctx.products = [];
  }
  ctx.officialLinks = await fetchJson(CONFIG.incidentLinksUrl).then(j => j.links || []).catch(() => []);
  // Metas are small; load them all so legends and source panels render synchronously.
  await Promise.all(ctx.products.map(p => ctx.meta(p.id).then(m => ctx.metas.set(p.id, m)).catch(() => null)));
}

async function loadConditions() {
  try {
    ctx.conditions = await import('./ui/conditions.js');
  } catch (err) {
    console.warn('conditions module unavailable:', err.message);
  }
}

/* ---------- selection ---------- */
let marker = null;
function writeHash() {
  history.replaceState(null, '', buildHash(location.hash, {sel: ctx.selection, view: ctx.view}));
}

/**
 * Select a place (or clear with null). Persists across views, reloads (localStorage) and share links (hash).
 * fly: move the map there; a place with bbox [w, s, e, n] (a route) is fitted whole instead.
 */
export function setSelection(place, {fly = false, open = true} = {}) {
  ctx.selection = place;
  try { place ? localStorage.setItem(SEL_KEY, JSON.stringify(place)) : localStorage.removeItem(SEL_KEY); } catch { /* blocked */ }
  writeHash();
  if (!place) { marker?.remove(); marker = null; if (sheet.owner === 'place') sheet.close(); return; }
  if (!marker) marker = new maplibregl.Marker({element: el('div', {class: 'sel-marker', 'aria-hidden': 'true'})});
  marker.setLngLat([place.lon, place.lat]).addTo(map);
  if (fly && place.bbox) map.fitBounds([[place.bbox[0], place.bbox[1]], [place.bbox[2], place.bbox[3]]], {padding: 50, maxZoom: 15});
  else if (fly) map.flyTo({center: [place.lon, place.lat], zoom: Math.max(map.getZoom(), place.zoom || 13), essential: true});
  if (ctx.view === 'conditions') return showView('conditions');
  if (open) showPlace();
}

function placeActions() {
  const p = ctx.selection;
  return {
    isSaved: isFavorite(p),
    conditions: () => showView('conditions'),
    save: async () => {
      try { toast(await toggleFavorite(p) ? 'Saved to this device' : 'Removed from saved'); } catch (err) { toast(`Could not save on this device (${err?.message || err}).`, 6000); return; }
      showPlace();
    },
    share: () => shareLink(),
    clear: () => setSelection(null)
  };
}

function showPlace(features = [], force = false) {
  const p = ctx.selection;
  if (!p) return;
  sheet.open({owner: 'place', title: p.name || 'Selected point', snap: 'peek', force,
    content: renderPlaceCard({place: p, features, ctx, actions: placeActions()})});
}

async function shareLink() {
  const url = location.href;
  try {
    if (navigator.share) await navigator.share({title: ctx.selection?.name || 'Skintrack CO', url});
    else { await navigator.clipboard.writeText(url); toast('Link copied'); }
  } catch (err) {
    if (err?.name !== 'AbortError') toast(`Could not share: ${url}`, 8000);
  }
}

/* ---------- views ---------- */
function setTab(view) {
  ctx.view = view;
  document.querySelectorAll('.tab').forEach(t => (t.dataset.view === view ? t.setAttribute('aria-current', 'page') : t.removeAttribute('aria-current')));
  writeHash();
}

function conditionsContent() {
  const p = ctx.selection;
  if (!p) {
    return el('div', {}, el('p', {}, 'Pick a place first: tap the map, search, or use the map center.'),
      el('button', {class: 'btn primary', type: 'button', onclick: () => {
        const c = map.getCenter(); setSelection({lon: c.lng, lat: c.lat}, {open: false}); showView('conditions');
      }}, 'Use map center'));
  }
  const box = el('div', {class: 'conditions-host'});
  if (!ctx.conditions) box.append(el('p', {class: 'note'}, 'The conditions module is not available yet. Official CAIC forecast: ', el('a', {href: CONFIG.providers.officialLinks.caicForecast, target: '_blank', rel: 'noopener noreferrer'}, 'avalanche.state.co.us')));
  else {
    const view = ctx.conditions.createConditionsView(box);
    if (p.station) view.showStation(p.station); else view.show(p);
  }
  return box;
}

/** Switch the bottom-nav view. The map stays mounted; views render into the sheet. */
export function showView(view, opts = {}) {
  setTab(view);
  if (view === 'map') { if (ctx.selection) showPlace([], true); else sheet.close(); return; }
  if (view === 'conditions') {
    const p = ctx.selection;
    sheet.open({owner: 'conditions', title: p ? `Conditions: ${p.name || fmtLatLon(p.lon, p.lat)}` : 'Conditions', snap: 'full', content: conditionsContent(), focus: opts.focus});
  } else if (view === 'explore') {
    sheet.open({owner: 'explore', title: 'Explore', snap: 'half', content: renderExplore(ctx, {map, select: selectFromList}), focus: opts.focus});
  } else if (view === 'saved') {
    sheet.open({owner: 'saved', title: 'Saved', snap: 'half', content: renderSaved(ctx, {map, select: selectFromList, openSources}), focus: opts.focus});
  }
}

function selectFromList(place) {
  setTab('map');
  setSelection(place, {fly: true});
}

function unitsToggle() {
  const make = (u, label) => el('button', {type: 'button', 'aria-pressed': String(getUnits() === u), onclick: () => { setUnits(u); openLayers(); }}, label);
  return el('div', {class: 'row', style: 'justify-content:space-between;margin-bottom:12px'},
    el('div', {class: 'seg', role: 'group', 'aria-label': 'Units'}, make('imperial', 'ft, mi'), make('metric', 'm, km')),
    el('button', {class: 'btn', type: 'button', onclick: openSources}, 'Sources and methods'));
}

function openLayers() {
  sheet.open({owner: 'layers', title: 'Layers', snap: 'half', focus: true, content: renderLayersPanel(reg, ctx, {header: unitsToggle()})});
}
function openSources() {
  sheet.open({owner: 'sources', title: 'Sources and methods', snap: 'full', focus: true, content: renderSources(ctx, reg)});
}

/* ---------- map chrome ---------- */
let offlineNote = null;
/** When the device is offline, say whether the view is inside a downloaded area (missing coverage must be obvious). */
async function updateOffline() {
  if (navigator.onLine) { offlineNote = null; return updateChips(); }
  const c = map.getCenter();
  const pkgs = await listPackages().catch(() => []);
  const inside = pkgs.find(p => p.status !== 'deleting' && bboxContains(p.bbox, [c.lng, c.lat]));
  offlineNote = inside ? `Offline: using downloaded area "${inside.name}"${inside.status === 'complete' ? '' : ' (incomplete)'}`
    : 'Offline: outside your downloaded areas. Map and terrain are missing here.';
  updateChips();
}

function updateChips() {
  const chips = reg.visible().map(d => (typeof d.chip === 'function' ? d.chip(ctx) : d.chip)).filter(Boolean);
  document.getElementById('chips').replaceChildren(...(offlineNote ? [el('span', {class: 'chip warn'}, offlineNote)] : []),
    ...chips.map(t => el('span', {class: `chip${/Experimental/.test(t) ? ' exp' : ' info'}`}, t)));
}

function updateCoords() {
  const c = map.getCenter();
  document.getElementById('coords').textContent = `${fmtLatLon(c.lng, c.lat)}  z${map.getZoom().toFixed(1)}`;
  document.getElementById('north-icon').style.transform = `rotate(${-map.getBearing()}deg)`;
}

function wireControls() {
  document.getElementById('btn-layers').addEventListener('click', openLayers);
  document.getElementById('btn-north').addEventListener('click', () => map.easeTo({bearing: 0, pitch: 0}));
  const b3d = document.getElementById('btn-3d');
  b3d.addEventListener('click', () => {
    const on = b3d.getAttribute('aria-pressed') !== 'true';
    b3d.setAttribute('aria-pressed', String(on));
    if (on) {
      if (!map.getSource('dem3d')) map.addSource('dem3d', {type: 'raster-dem', tiles: ['skt://tile/dem/{z}/{x}/{y}'], tileSize: DEM.tileSize, encoding: 'terrarium', maxzoom: DEM.maxzoom});
      map.setTerrain({source: 'dem3d', exaggeration: 1.3});
      map.easeTo({pitch: 60});
      toast('3D view: exaggerated 1.3x for display. Inspector numbers are unaffected.');
    } else { map.setTerrain(null); map.easeTo({pitch: 0}); }
  });
  document.getElementById('coords').addEventListener('click', async () => {
    const c = map.getCenter();
    try { await navigator.clipboard.writeText(`${c.lat.toFixed(5)}, ${c.lng.toFixed(5)}`); toast('Coordinates copied'); } catch { toast(fmtLatLon(c.lng, c.lat)); }
  });
  document.querySelectorAll('.tab').forEach(t => t.addEventListener('click', () => showView(t.dataset.view, {focus: true})));
  map.on('move', updateCoords);
  map.on('moveend', () => { if (!navigator.onLine) updateOffline(); });
  window.addEventListener('online', updateOffline);
  window.addEventListener('hashchange', () => { // a pasted share link: follow its selection and view
    const h = parseHash(location.hash);
    if (h.sel && (h.sel.lat !== ctx.selection?.lat || h.sel.lon !== ctx.selection?.lon)) setSelection(h.sel, {open: !h.view});
    if (h.view && h.view !== ctx.view) showView(h.view);
  });
  window.addEventListener('offline', updateOffline);
  map.on('click', e => {
    if (ctx.onMapClick) return ctx.onMapClick(e);
    if (ctx.view !== 'map') setTab('map');
    const features = featuresAt(map, reg, e.point);
    const station = features.find(f => f.def.id === 'snotel');
    if (station) { // a station tap opens that station in Conditions
      const c = station.feature.geometry.coordinates;
      setSelection({lon: c[0], lat: c[1], ...station.def.toPlace(station.feature, ctx)}, {open: false});
      return showView('conditions');
    }
    const named = features.find(f => f.def.toPlace);
    setSelection({lon: e.lngLat.lng, lat: e.lngLat.lat, ...(named ? named.def.toPlace(named.feature, ctx) : {})}, {open: false});
    showPlace(features);
  });
  window.addEventListener('skintrack:units', () => { applyUnitsToMap(map, getUnits()); if (sheet.owner === 'place') showPlace(); });
}

/* ---------- boot ---------- */
let map = null;
const sheet = createSheet({onResize: (px, side) => map?.setPadding(side ? {left: px, bottom: 0} : {bottom: px, left: 0}), onClose: () => { if (ctx.view !== 'map') setTab('map'); }});
installTerrain();
const manifestLoaded = loadManifest(); // never rejects; runs while the map starts so a slow network does not delay the map
try {
  ({map} = await createMap(document.getElementById('map'), getUnits()));
} catch (err) {
  document.body.append(el('p', {class: 'noscript', role: 'alert'}, `The map could not start in this browser (${err.message}). It needs WebGL.`));
  throw err;
}
await manifestLoaded;
ctx.map = map;
const reg = createRegistry(map, ctx, [...terrainLayers(), ...overlayLayers()]);
ctx.reg = reg;
reg.events.addEventListener('change', updateChips);
wireControls();
updateCoords();
initSearch(ctx, {map, select: selectFromList});
initLocate(map);
setOfflineIndexFromStore().catch(err => console.warn('offline index:', err.message));
initSaved(map).catch(err => console.warn('saved items:', err.message));
updateOffline();
reg.init().catch(err => console.warn('layers:', err.message)); // layers load in the background; the selection below must not wait for them
setupTier2(ctx, map).catch(err => console.warn('tier 2 unavailable:', err.message));
loadConditions().then(() => { if (sheet.owner === 'place') showPlace(); if (ctx.view === 'conditions') showView('conditions'); });

const fromHash = parseHash(location.hash);
let saved = null;
try { saved = JSON.parse(localStorage.getItem(SEL_KEY)); } catch { /* none */ }
const initial = fromHash.sel || saved;
if (initial && Number.isFinite(initial.lon) && Number.isFinite(initial.lat)) setSelection(initial, {open: fromHash.view == null});
if (fromHash.view && fromHash.view !== 'map') showView(fromHash.view);
globalThis.__skintrack = {map, ctx, reg, sheet};
if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('./sw.js', {scope: './'}).catch(err => console.warn('service worker not registered:', err.message));
}
