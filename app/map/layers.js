// Layer registry: one place that knows every toggleable layer, its group, visibility, opacity and status.
// Layer definitions live in app/layers/*.js. Heavy layers are set up lazily the first time they are shown.
//
// Definition fields:
//   id, group, title, defaultOn, opacity (default or null), opacityProps [[mapLayerId, paintProp]]
//   mapLayers: map layer ids toggled together; sources: map source ids watched for loading/failure
//   unavailable(ctx): string reason when the product is missing, else null
//   setup(ctx): async, adds sources and layers (hidden); legend(ctx): Node; info(ctx): {text, metaUrl, links}
//   chip: persistent label shown while on; minzoom: zoom below which nothing draws
//   query: map layer ids the inspector queries; describe(feature, ctx): inspector card content

export const GROUPS = [
  ['terrain', 'Terrain'], ['avalanche', 'Modeled avalanche terrain'], ['forecast', 'Official forecasts'],
  ['history', 'Historical observations'], ['routes', 'Routes and access'], ['weather', 'Weather'], ['snow', 'Snow']
];
const PREFS_KEY = 'skintrack-layers';

function loadPrefs() {
  try { return JSON.parse(localStorage.getItem(PREFS_KEY)) || {}; } catch { return {}; }
}

export function createRegistry(map, ctx, defs) {
  const prefs = loadPrefs();
  const events = new EventTarget();
  const state = new Map(defs.map(d => [d.id, {on: prefs[d.id]?.on ?? !!d.defaultOn, opacity: prefs[d.id]?.opacity ?? d.opacity ?? null,
    status: 'off', detail: '', ready: null}]));
  const byId = new Map(defs.map(d => [d.id, d]));

  const emit = id => events.dispatchEvent(new CustomEvent('change', {detail: {id}}));
  const save = () => {
    const out = {};
    for (const [id, s] of state) out[id] = {on: s.on, opacity: s.opacity};
    try { localStorage.setItem(PREFS_KEY, JSON.stringify(out)); } catch { /* storage blocked: session only */ }
  };
  const setStatus = (id, status, detail = '') => {
    const s = state.get(id);
    if (s.status === status && s.detail === detail) return;
    Object.assign(s, {status, detail});
    emit(id);
  };

  function applyPaint(d) {
    const s = state.get(d.id);
    for (const lid of d.mapLayers || []) if (map.getLayer(lid)) map.setLayoutProperty(lid, 'visibility', s.on ? 'visible' : 'none');
    if (s.opacity !== null) for (const [lid, prop, scale = 1] of d.opacityProps || []) if (map.getLayer(lid)) map.setPaintProperty(lid, prop, s.opacity * scale);
    d.onToggle?.(ctx, s.on);
  }

  async function setOn(id, on) {
    const d = byId.get(id); const s = state.get(id);
    s.on = on; save();
    if (!on) { applyPaint(d); setStatus(id, 'off'); return; }
    const reason = d.unavailable?.(ctx);
    if (reason) { s.on = false; save(); setStatus(id, 'unavailable', reason); return; }
    setStatus(id, 'loading');
    try {
      s.ready ||= Promise.resolve(d.setup?.(ctx));
      await s.ready;
    } catch (err) {
      s.ready = null;
      setStatus(id, 'failed', err.message || String(err));
      return;
    }
    if (!s.on) return;
    applyPaint(d);
    refresh(d);
  }

  function setOpacity(id, v) {
    const s = state.get(id); s.opacity = v; save();
    applyPaint(byId.get(id));
  }

  /** Recompute a visible layer's status from its sources. */
  function refresh(d) {
    const s = state.get(d.id);
    if (!s.on || s.status === 'failed' || s.status === 'unavailable') return;
    if (d.minzoom && map.getZoom() < d.minzoom) return setStatus(d.id, 'zoom', `Zoom in to see this layer (from zoom ${d.minzoom})`);
    const loading = (d.sources || []).some(src => map.getSource(src) && !map.isSourceLoaded(src));
    setStatus(d.id, loading ? 'loading' : 'ready');
  }

  map.on('error', e => {
    const src = e.sourceId || e.source?.id;
    if (!src) return;
    for (const d of defs) {
      if (state.get(d.id).on && (d.sources || []).includes(src)) setStatus(d.id, 'failed', `Some tiles failed to load (${e.error?.message || 'network error'})`);
    }
  });
  map.on('idle', () => defs.forEach(refresh));
  map.on('zoomend', () => defs.forEach(d => { const s = state.get(d.id); if (s.status === 'zoom' || s.status === 'ready') { s.status = 'x'; refresh(d); } }));

  /** Turn on every layer whose saved or default state is on, all at once (one slow download does not hold up the rest). */
  async function init() {
    await Promise.all(defs.map(d => {
      const reason = d.unavailable?.(ctx);
      if (reason) { state.get(d.id).on = false; setStatus(d.id, 'unavailable', reason); return null; }
      return state.get(d.id).on ? setOn(d.id, true) : applyPaint(d);
    }));
  }

  /** Re-check availability after products change (for example the manifest reloads). */
  function recheck() {
    for (const d of defs) {
      const s = state.get(d.id);
      const reason = d.unavailable?.(ctx);
      if (reason) setStatus(d.id, 'unavailable', reason);
      else if (s.status === 'unavailable') setStatus(d.id, 'off');
    }
  }

  return {defs, state, events, init, setOn, setOpacity, recheck, get: id => byId.get(id),
    visible: () => defs.filter(d => state.get(d.id).on)};
}
