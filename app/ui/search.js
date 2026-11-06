// Search: places index (data/places/search.json), your saved and imported items, and decimal coordinates.
import {el} from './dom.js';
import {parseCoordinates} from '../lib/geo.js';
import {fetchJson} from '../lib/net.js';
import {CLASS_LABELS} from '../layers/routes.js';
import {savedItems} from './saved.js';

let index = null; // [{name, lower, cls, lon, lat, region, elevationM}]
let indexError = null;

async function loadIndex(ctx) {
  if (index || indexError) return;
  const p = ctx.products.find(x => x.id === 'search' || /search\.json$/.test(x.url || ''));
  try {
    const raw = await fetchJson(p ? `./${p.url}` : './data/places/search.json');
    const f = Object.fromEntries(raw.fields.map((k, i) => [k, i]));
    index = raw.rows.filter(r => Number.isFinite(r[f.lon]) && Number.isFinite(r[f.lat])).map(r => ({
      name: String(r[f.name]), lower: String(r[f.name]).toLowerCase(), cls: r[f.class], lon: r[f.lon], lat: r[f.lat], region: r[f.region] ?? null}));
  } catch (err) { indexError = err; }
}

/** Rank: prefix of the name, then prefix of a word, then substring. Pure, exported for tests. */
export function rank(items, q, limit = 12) {
  const s = q.trim().toLowerCase();
  if (s.length < 2) return [];
  const out = [];
  for (const it of items) {
    const i = it.lower.indexOf(s);
    if (i < 0) continue;
    const score = i === 0 ? 0 : /[\s\-(/]/.test(it.lower[i - 1]) ? 1 : 2;
    out.push([score, it.lower.length, it]);
  }
  return out.sort((a, b) => a[0] - b[0] || a[1] - b[1]).slice(0, limit).map(x => x[2]);
}

export function initSearch(ctx, {select}) {
  const form = document.getElementById('search-form');
  const input = document.getElementById('search-input');
  const list = document.getElementById('search-results');
  const clear = document.getElementById('search-clear');
  let results = []; let active = -1;

  const close = () => { list.hidden = true; input.setAttribute('aria-expanded', 'false'); active = -1; };
  const choose = r => { close(); input.blur(); select({lon: r.lon, lat: r.lat, name: r.name, sub: r.sub, zoom: 13}); };
  function render(note) {
    list.replaceChildren(...results.map((r, i) => el('li', {role: 'option', id: `sr-${i}`, 'aria-selected': String(i === active), onclick: () => choose(r)},
      el('span', {}, r.name), el('span', {class: 'sub'}, r.sub))));
    if (!results.length) list.append(el('li', {class: 'empty', role: 'option', 'aria-disabled': 'true'}, note));
    list.hidden = false;
    input.setAttribute('aria-expanded', 'true');
    input.setAttribute('aria-activedescendant', active >= 0 ? `sr-${active}` : '');
  }
  async function update() {
    const q = input.value;
    clear.hidden = !q;
    if (!q.trim()) return close();
    const coord = parseCoordinates(q);
    if (coord) { results = [{lon: coord[0], lat: coord[1], name: `${coord[1].toFixed(5)}, ${coord[0].toFixed(5)}`, sub: 'Coordinates (lat, lon)'}]; active = 0; return render(); }
    await loadIndex(ctx);
    const mine = (await savedItems().catch(() => [])).map(s => ({...s, lower: s.name.toLowerCase(), cls: 'saved'}));
    results = rank([...mine, ...(index || [])], q).map(r => ({...r, sub: [r.cls === 'saved' ? 'Saved on this device' : CLASS_LABELS[r.cls] || r.cls, r.region].filter(Boolean).join(' · ')}));
    active = results.length ? 0 : -1;
    render(indexError ? 'Place index unavailable. Coordinates still work, for example 39.798, -105.777.' : q.trim().length < 2 ? 'Keep typing…' : 'No match. Try a peak, pass or trailhead name, or lat, lon.');
  }
  input.addEventListener('input', update);
  input.addEventListener('focus', () => loadIndex(ctx));
  input.addEventListener('keydown', e => {
    if (list.hidden) return;
    if (e.key === 'ArrowDown') { active = Math.min(results.length - 1, active + 1); render(); e.preventDefault(); }
    if (e.key === 'ArrowUp') { active = Math.max(0, active - 1); render(); e.preventDefault(); }
    if (e.key === 'Escape') close();
  });
  form.addEventListener('submit', e => { e.preventDefault(); if (results[active]) choose(results[active]); });
  clear.addEventListener('click', () => { input.value = ''; clear.hidden = true; close(); input.focus(); });
  document.addEventListener('pointerdown', e => { if (!form.contains(e.target) && !list.contains(e.target)) close(); });
}
