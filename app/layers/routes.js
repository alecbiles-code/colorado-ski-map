// Routes and access: ski routes by class, places (peaks, passes, trailheads, parking, huts), ski areas,
// land status and the app's reporting regions. Feature classes stay visually distinct.
import {el} from '../ui/dom.js';
import {fmtDistance, fmtElevation, fmtAngle} from '../lib/units.js';
import {aspectName} from '../lib/terrain-math.js';
import {addGeojson, metaInfo, product, prop} from './common.js';

export const CLASS_LABELS = {ski_descent: 'Ski descent', ascent_skin: 'Skin or tour route', approach: 'Winter approach', touring_area: 'Touring area',
  peak: 'Peak', pass: 'Pass', trailhead: 'Trailhead', parking: 'Parking', hut: 'Hut', ski_area: 'Ski area', user_route: 'Your route'};
const ROUTE_COLORS = {ski_descent: '#0b3d91', ascent_skin: '#1b7f3a', approach: '#7a4b2a', touring_area: '#0b3d91'};
const PLACE_COLORS = {peak: '#3a2a1a', pass: '#5b3a8c', trailhead: '#0f6e6e', parking: '#0f6e6e', hut: '#a3460f'};
const byId = id => ctx => product(ctx, p => p.id === id);
const LINE_IDS = ['routes-approach', 'routes-ascent_skin', 'routes-ski_descent'];
const parseObj = v => { if (!v || typeof v === 'object') return v; try { return JSON.parse(v); } catch { return null; } };

/** Card lines for a route or place feature (shared by the inspector and Explore). */
export function routeLines(f) {
  const access = parseObj(prop(f, 'winterAccess'));
  const asp = prop(f, 'demMeanAspectDeg');
  return [['Class', CLASS_LABELS[prop(f, 'class')] || prop(f, 'class')], ['Region', prop(f, 'region')],
    ['Source difficulty', prop(f, 'sourceDifficulty')], ['Length', prop(f, 'lengthM') === null ? null : fmtDistance(prop(f, 'lengthM'))],
    ['Gain / loss (DEM-derived)', prop(f, 'demGainM') === null ? null : `${fmtElevation(prop(f, 'demGainM'))} / ${fmtElevation(prop(f, 'demLossM'))}`],
    ['Mean aspect (DEM-derived)', asp === null ? null : `${aspectName(asp, 8)} (${fmtAngle(asp)})`],
    ['Elevation', prop(f, 'elevationM') === null ? null : fmtElevation(prop(f, 'elevationM'))],
    ['Access notes', access ? Object.entries(access).map(([k, v]) => `${k}=${v}`).join(', ') : prop(f, 'access')],
    ['Description (source)', prop(f, 'description')]];
}

const describeRoute = f => ({title: prop(f, 'name') || CLASS_LABELS[prop(f, 'class')] || 'Unnamed route', badge: CLASS_LABELS[prop(f, 'class')],
  meaning: prop(f, 'class') === 'touring_area' ? 'A touring area polygon from the source, not a descent line.' : 'Mapped route from the source; check it against current conditions and access.',
  lines: [...routeLines(f), ['Source', prop(f, 'source')]], links: [['Source record', prop(f, 'sourceUrl')]]});

function routesLayer() {
  const p = byId('routes');
  const cls = c => ['==', ['get', 'class'], c];
  return {
    id: 'routes', group: 'routes', title: 'Ski routes and approaches', defaultOn: false, opacity: 1, sources: ['routes'],
    mapLayers: ['routes-area', 'routes-area-line', ...LINE_IDS, 'routes-label'], query: [...LINE_IDS, 'routes-area'],
    opacityProps: LINE_IDS.map(id => [id, 'line-opacity']),
    unavailable: ctx => (p(ctx) ? null : 'Route data has not been published yet.'),
    setup: async ctx => {
      const m = ctx.map;
      await addGeojson(m, 'routes', p(ctx).url);
      m.addLayer({id: 'routes-area', type: 'fill', source: 'routes', filter: cls('touring_area'), layout: {visibility: 'none'}, paint: {'fill-color': '#0b3d91', 'fill-opacity': 0.08}}, 'anchor-overlay');
      m.addLayer({id: 'routes-area-line', type: 'line', source: 'routes', filter: cls('touring_area'), layout: {visibility: 'none'}, paint: {'line-color': '#0b3d91', 'line-width': 1.5, 'line-dasharray': [4, 2]}}, 'anchor-overlay');
      // One layer per class: line-dasharray is not data-driven, and the classes must stay visually distinct.
      for (const [c, dash] of [['approach', [0.5, 1.5]], ['ascent_skin', [2, 1]], ['ski_descent', null]]) {
        m.addLayer({id: `routes-${c}`, type: 'line', source: 'routes', filter: cls(c), layout: {visibility: 'none', 'line-cap': dash ? 'butt' : 'round'},
          paint: {'line-color': ROUTE_COLORS[c], 'line-width': ['interpolate', ['linear'], ['zoom'], 9, 1.5, 14, 3.5], ...(dash ? {'line-dasharray': dash} : {})}}, 'anchor-overlay');
      }
      m.addLayer({id: 'routes-label', type: 'symbol', source: 'routes', minzoom: 12, layout: {visibility: 'none', 'symbol-placement': 'line', 'text-field': ['coalesce', ['get', 'name'], ''],
        'text-font': ['Noto Sans Medium'], 'text-size': 12}, paint: {'text-color': '#0b2a63', 'text-halo-color': '#fff', 'text-halo-width': 1.5}});
    },
    toPlace: f => ({name: prop(f, 'name') || undefined}),
    describe: describeRoute,
    legend: () => el('div', {class: 'legend'}, ['ski_descent', 'ascent_skin', 'approach'].map(c => el('span', {}, el('i', {class: 'line', style: `background:${ROUTE_COLORS[c]}`}), CLASS_LABELS[c])),
      el('span', {}, el('i', {style: 'background:#0b3d9122;border:1px dashed #0b3d91'}), 'Touring area')),
    info: ctx => metaInfo(ctx.metas.get('routes'), {metaUrl: p(ctx)?.meta})
  };
}

function placesLayer() {
  const p = byId('places');
  return {
    // On by default: the basemap extract has no peak or pass names, so this layer is the map's only source of them.
    id: 'places', group: 'routes', title: 'Peaks, passes, trailheads and huts', defaultOn: true, opacity: null, sources: ['places'],
    mapLayers: ['places-dot', 'places-label'], query: ['places-dot'],
    unavailable: ctx => (p(ctx) ? null : 'Place data has not been published yet.'),
    setup: async ctx => {
      const m = ctx.map;
      await addGeojson(m, 'places', p(ctx).url);
      const color = ['match', ['get', 'class'], ...Object.entries(PLACE_COLORS).flat(), '#333'];
      m.addLayer({id: 'places-dot', type: 'circle', source: 'places', minzoom: 9, layout: {visibility: 'none'},
        paint: {'circle-radius': ['interpolate', ['linear'], ['zoom'], 9, 3, 14, 6], 'circle-color': color, 'circle-stroke-color': '#fff', 'circle-stroke-width': 1.5}}, 'anchor-overlay');
      m.addLayer({id: 'places-label', type: 'symbol', source: 'places', minzoom: 11, layout: {visibility: 'none', 'text-field': ['coalesce', ['get', 'name'], ''],
        'text-font': ['Noto Sans Medium'], 'text-size': 12, 'text-offset': [0, 0.9], 'text-anchor': 'top', 'text-optional': true},
      paint: {'text-color': color, 'text-halo-color': '#fff', 'text-halo-width': 1.5}});
    },
    toPlace: f => ({name: prop(f, 'name') || undefined}),
    describe: f => ({title: prop(f, 'name') || CLASS_LABELS[prop(f, 'class')], badge: CLASS_LABELS[prop(f, 'class')], lines: routeLines(f),
      meaning: prop(f, 'class') === 'parking' || prop(f, 'class') === 'trailhead' ? 'Mapped location. Mapping is not proof of legal or plowed winter parking.' : null,
      links: [['Source record', prop(f, 'sourceUrl')]]}),
    legend: () => el('div', {class: 'legend'}, Object.entries(PLACE_COLORS).map(([c, col]) => el('span', {}, el('i', {class: 'dot', style: `background:${col}`}), CLASS_LABELS[c]))),
    info: ctx => metaInfo(ctx.metas.get('places'), {metaUrl: p(ctx)?.meta})
  };
}

// Land manager colours (US public-lands map convention, softened). Private land has no polygon in the source.
const AGENCY_COLORS = {USFS: '#4c9a2a', BLM: '#e0b13a', NPS: '#8e5aa8', ST: '#3d7cc9', FWS: '#2aa198', DOD: '#9b2d2d', BIA: '#c46a2b', USBR: '#7f8c8d', LG: '#5c6bc0', OTHFE: '#8d6e63'};

function polygonLayer({id, title, productId, color, caveat, labelField, colorExpr, legendItems}) {
  const p = byId(productId);
  return {
    id, group: 'routes', title, defaultOn: false, opacity: 0.5, sources: [id], mapLayers: [`${id}-fill`, `${id}-line`, `${id}-label`], query: [`${id}-fill`],
    opacityProps: [[`${id}-fill`, 'fill-opacity', 0.3]],
    unavailable: ctx => (p(ctx) ? null : `${title} have not been published yet.`),
    setup: async ctx => {
      const m = ctx.map;
      await addGeojson(m, id, p(ctx).url);
      const c = colorExpr || color;
      m.addLayer({id: `${id}-fill`, type: 'fill', source: id, filter: ['!=', ['geometry-type'], 'Point'], layout: {visibility: 'none'}, paint: {'fill-color': c}}, 'anchor-terrain');
      m.addLayer({id: `${id}-line`, type: 'line', source: id, filter: ['!=', ['geometry-type'], 'Point'], layout: {visibility: 'none'}, paint: {'line-color': c, 'line-width': 1.5}}, 'anchor-overlay');
      m.addLayer({id: `${id}-label`, type: 'symbol', source: id, minzoom: 8, layout: {visibility: 'none', 'text-field': ['coalesce', ['get', labelField], ''], 'text-font': ['Noto Sans Italic'], 'text-size': 12,
        'symbol-placement': 'point', 'text-optional': true}, paint: {'text-color': '#222', 'text-halo-color': '#fff', 'text-halo-width': 1.5}});
    },
    describe: f => ({title: prop(f, labelField) || title, meaning: caveat, lines: Object.entries(f.properties || {}).filter(([k]) => !/^(id|sourceUrl)$/.test(k)).slice(0, 8).map(([k, v]) => [k, String(v)]),
      links: [['Source', prop(f, 'sourceUrl')]]}),
    legend: () => el('div', {}, el('div', {class: 'legend'}, (legendItems || [[color, title]]).map(([c, t]) => el('span', {}, el('i', {style: `background:${c}55;border:1.5px solid ${c}`}), t))),
      el('p', {class: 'small muted'}, caveat)),
    info: ctx => metaInfo(ctx.metas.get(productId), {metaUrl: p(ctx)?.meta})
  };
}

export function routesLayers() {
  return [routesLayer(), placesLayer(),
    polygonLayer({id: 'ski-areas', title: 'Ski areas', productId: 'ski-areas', color: '#5a5a5a', labelField: 'name',
      caveat: 'Resort boundaries are approximate and are not permit or closure boundaries. Abandoned areas may be private land.'}),
    polygonLayer({id: 'land', title: 'Land manager', productId: 'land-status', color: '#7b5ea7', labelField: 'name',
      colorExpr: ['match', ['get', 'agencyCode'], ...Object.entries(AGENCY_COLORS).flat(), '#999999'],
      legendItems: [['#4c9a2a', 'Forest Service'], ['#e0b13a', 'BLM'], ['#8e5aa8', 'National Park Service'], ['#3d7cc9', 'State'], ['#9b2d2d', 'Defense'], ['#999999', 'Other public']],
      caveat: 'Managing agency only (BLM surface management data, simplified to about 30 m). Not current legal access, closures, parking or permission; State land is often closed without a lease or permit. Unshaded land is outside these agency polygons (mostly private).'}),
    polygonLayer({id: 'regions', title: 'Data coverage regions', productId: 'regions', color: '#c2185b', labelField: 'name',
      caveat: 'App-defined reporting regions (approximate). Not official boundaries and not CAIC forecast zones.'})];
}
