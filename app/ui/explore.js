// Explore: destinations and routes near the selected place (or the map center), with source-backed cards.
import {el, kv, link} from './dom.js';
import {loadGeojson, product} from '../layers/common.js';
import {CLASS_LABELS, routeLines} from '../layers/routes.js';
import {distanceM, geojsonBbox} from '../lib/geo.js';
import {fmtDistance} from '../lib/units.js';
import {fmtDay} from '../lib/time.js';

const FILTERS = [['all', 'All'], ['ski_descent', 'Descents'], ['ascent_skin', 'Skin routes'], ['approach', 'Approaches'], ['touring_area', 'Touring areas'],
  ['trailhead', 'Trailheads'], ['parking', 'Parking'], ['hut', 'Huts'], ['peak', 'Peaks'], ['pass', 'Passes']];
let filter = 'all';

/** Minimum distance from a point to any vertex of a geometry (metres). Pure. */
export function nearestVertexM(pt, geom) {
  let best = Infinity;
  const walk = c => { if (typeof c[0] === 'number') best = Math.min(best, distanceM(pt, c)); else c.forEach(walk); };
  walk(geom.coordinates);
  return best;
}

function card(f, d, meta, {select}) {
  const p = f.properties;
  const lines = routeLines({properties: p});
  const show = () => {
    const b = geojsonBbox(f);
    const wide = b && (b[2] - b[0] > 1e-4 || b[3] - b[1] > 1e-4);
    const c = f.geometry.type === 'Point' ? f.geometry.coordinates : [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2];
    select({lon: c[0], lat: c[1], name: p.name || CLASS_LABELS[p.class], ...(wide ? {bbox: b} : {})});
  };
  return el('div', {class: 'card'},
    el('h4', {}, p.name || `Unnamed ${CLASS_LABELS[p.class] || 'feature'}`, ' ', el('span', {class: 'badge'}, CLASS_LABELS[p.class] || p.class)),
    kv([['Distance', `${fmtDistance(d)} away`], ...lines.filter(([k]) => k !== 'Class')]),
    el('p', {class: 'small muted'}, `Source: ${p.source || 'n/a'}. Updated: ${meta?.processedAt ? fmtDay(meta.processedAt) : 'n/a'} (processed)${meta?.sources?.[0]?.retrievedAt ? `, retrieved ${fmtDay(meta.sources[0].retrievedAt)}` : ''}. Gain, loss and aspect are DEM-derived, not source ratings.`),
    el('div', {class: 'row'}, el('button', {class: 'btn primary', type: 'button', onclick: show}, 'Show on map'), link(p.sourceUrl, 'Source record')));
}

/** Render Explore into a fresh node. */
export function renderExplore(ctx, {map, select}) {
  const origin = ctx.selection ? [ctx.selection.lon, ctx.selection.lat] : [map.getCenter().lng, map.getCenter().lat];
  const list = el('div', {}, el('p', {class: 'muted'}, 'Loading nearby routes and places…'));
  const chips = el('div', {class: 'row', role: 'group', 'aria-label': 'Filter', style: 'margin:8px 0'});
  const routesP = product(ctx, p => p.id === 'routes');
  const placesP = product(ctx, p => p.id === 'places');
  const toggle = id => {
    const d = ctx.reg.get(id);
    if (!d) return null;
    const s = ctx.reg.state.get(id);
    const label = () => `${s.on ? 'Hide' : 'Show'} ${d.title.toLowerCase()}`;
    // setOn updates s.on synchronously, so read the state after the call.
    return el('button', {class: 'btn', type: 'button', 'aria-pressed': String(s.on), disabled: s.status === 'unavailable',
      onclick: e => { ctx.reg.setOn(id, !s.on); e.currentTarget.setAttribute('aria-pressed', String(s.on)); e.currentTarget.textContent = label(); }}, label());
  };
  async function fill() {
    if (!routesP && !placesP) {
      list.replaceChildren(el('p', {class: 'note'}, 'Route and destination data have not been published yet. Search and the map still work.'));
      return;
    }
    const [routes, places] = await Promise.all([routesP ? loadGeojson(routesP.url).catch(() => null) : null, placesP ? loadGeojson(placesP.url).catch(() => null) : null]);
    const metas = {routes: ctx.metas.get('routes'), places: ctx.metas.get('places')};
    const all = [...(routes?.features || []).map(f => [f, metas.routes]), ...(places?.features || []).filter(f => f.properties.class !== 'peak' || f.properties.name).map(f => [f, metas.places])];
    const near = all.filter(([f]) => filter === 'all' || f.properties.class === filter)
      .map(([f, m]) => [f, nearestVertexM(origin, f.geometry), m]).filter(([, d]) => d < 25000).sort((a, b) => a[1] - b[1]).slice(0, 30);
    list.replaceChildren(...(near.length ? near.map(([f, d, m]) => card(f, d, m, {select}))
      : [el('p', {class: 'empty-state'}, 'Nothing mapped within 25 km for this filter. Coverage is uneven: no mapped route does not mean no skiing, and a mapped route is not a recommendation.')]));
  }
  chips.append(...FILTERS.map(([k, label]) => el('button', {class: 'btn', type: 'button', 'aria-pressed': String(filter === k),
    onclick: e => { filter = k; chips.querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', String(b === e.currentTarget))); fill(); }}, label)));
  fill();
  return el('div', {},
    el('p', {class: 'small muted'}, ctx.selection ? `Near ${ctx.selection.name || 'the selected point'}.` : 'Near the map center. Select a place to explore around it.'),
    el('div', {class: 'row'}, toggle('regions'), toggle('land')),
    chips, list);
}
