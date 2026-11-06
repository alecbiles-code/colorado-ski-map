// URL hash state for share links. MapLibre owns the "map=zoom/lat/lon/bearing/pitch" parameter; this
// module owns "sel=lat,lon", "name=" and "v=" (view) and leaves every other parameter untouched.
import {cleanText} from './escape.js';

const VIEWS = new Set(['map', 'conditions', 'explore', 'saved']);

function params(hash) {
  const out = [];
  for (const part of String(hash || '').replace(/^#/, '').split('&')) {
    if (!part) continue;
    const i = part.indexOf('=');
    out.push(i < 0 ? [part, ''] : [part.slice(0, i), part.slice(i + 1)]);
  }
  return out;
}

const dec = v => { try { return decodeURIComponent(v); } catch { return ''; } };

/** Parse selection and view from a location hash. Invalid values are dropped, never guessed. */
export function parseHash(hash) {
  const p = new Map(params(hash));
  let sel = null;
  const m = /^(-?\d{1,2}(?:\.\d+)?),(-?\d{1,3}(?:\.\d+)?)$/.exec(dec(p.get('sel') || ''));
  if (m) {
    const lat = Number(m[1]); const lon = Number(m[2]);
    if (Math.abs(lat) <= 90 && Math.abs(lon) <= 180) {
      sel = {lon, lat};
      const name = cleanText(dec(p.get('name') || ''), 120);
      if (name) sel.name = name;
    }
  }
  const v = p.get('v');
  return {sel, view: VIEWS.has(v) ? v : null};
}

/** Return a new hash with sel/name/v replaced, keeping all other parameters (such as map=) in place. */
export function buildHash(hash, {sel, view}) {
  const kept = params(hash).filter(([k]) => k !== 'sel' && k !== 'name' && k !== 'v');
  if (sel) {
    kept.push(['sel', `${sel.lat.toFixed(5)},${sel.lon.toFixed(5)}`]);
    if (sel.name) kept.push(['name', encodeURIComponent(sel.name)]);
  }
  if (view && view !== 'map') kept.push(['v', view]);
  return `#${kept.map(([k, v]) => (v === '' ? k : `${k}=${v}`)).join('&')}`;
}
