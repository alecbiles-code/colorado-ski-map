// Terrain layers: hillshade, contours (both in the base style), slope and aspect shading (Tier 1 computed
// in the browser, Tier 2 pilot display tiles inside their coverage when published).
import {el} from '../ui/dom.js';
import {SLOPE_COLORS, ASPECT_COLORS, setTier2, tier2Info, DEM, tier1Source, SLOPE_MIN_MAPZOOM} from '../map/terrain.js';
import {SLOPE_CLASSES} from '../lib/terrain-math.js';
import {registerPmtiles} from '../map/tiles.js';
import {getUnits} from '../lib/units.js';
import {CONFIG} from '../config.js';

const rgb = c => `rgb(${c.join(',')})`;
const tier2Displays = ctx => ctx.products.filter(p => p.group === 'terrain' && /display/.test(p.kind || '') && /slope/.test(p.id));
const tier2Numerics = ctx => ctx.products.filter(p => p.kind === 'terrain-numeric');

const terrainInfo = () => ({
  text: `${DEM.name} terrain tiles (Terrarium-encoded, ${DEM.tileSize} px, keyless): ${DEM.sourceNote}. ` +
    'Hillshade, contours and Tier 1 slope and aspect are computed in this browser from those tiles.',
  links: [[`${DEM.name} sources and attribution`, DEM.docsUrl]]
});

const inBbox = ([lon, lat], b) => lon >= b[0] && lon <= b[2] && lat >= b[1] && lat <= b[3];
/**
 * Drop the pilot product when regional cell products cover all four corners of its box (the cells are
 * contiguous 1-degree or half-degree rectangles, and their values equal the pilot's), so each place is read once.
 */
export function withoutRedundantPilot(metas) {
  const pilot = metas.find(m => /-pilot$/.test(m.id));
  const cells = metas.filter(m => m !== pilot);
  if (!pilot || !cells.length) return metas;
  const [w, s, e, n] = pilot.bbox;
  const covered = [[w, s], [w, n], [e, s], [e, n]].every(pt => cells.some(c => inBbox(pt, c.bbox)));
  return covered ? cells : metas;
}

const unionBbox = bbs => [Math.min(...bbs.map(b => b[0])), Math.min(...bbs.map(b => b[1])), Math.max(...bbs.map(b => b[2])), Math.max(...bbs.map(b => b[3]))];

/**
 * Add the Tier 2 numeric-region outlines and, when published, the Tier 2 display tiles of every region as one
 * composited source. The source stops at the lowest region maxzoom (14) and MapLibre overzooms with nearest
 * resampling, so no region draws blank above its own top zoom.
 */
export async function setupTier2(ctx, map) {
  const [allNums, allDisps] = await Promise.all([tier2Numerics(ctx), tier2Displays(ctx)].map(list => Promise.all(list.map(p => ctx.meta(p.id)))));
  const nums = withoutRedundantPilot(allNums); const disps = withoutRedundantPilot(allDisps);
  if (!nums.length && !disps.length) return;
  setTier2(nums, disps);
  if (!map.getSource('t2-coverage')) {
    const features = nums.map(m => ({type: 'Feature', properties: {id: m.id}, geometry: m.coverage}));
    map.addSource('t2-coverage', {type: 'geojson', data: {type: 'FeatureCollection', features}});
    map.addLayer({id: 't2-outline', type: 'line', source: 't2-coverage', layout: {visibility: 'none'},
      paint: {'line-color': '#1b1b1b', 'line-width': 2, 'line-dasharray': [3, 2]}}, 'anchor-overlay');
  }
  if (!disps.length || map.getSource('t2-slope')) return; // checked after the await: the slope layer and boot both call this
  const minz = Math.min(...disps.map(m => m.minzoom ?? 0)); const maxz = Math.min(...disps.map(m => m.maxzoom ?? 14));
  const bounds = unionBbox(disps.map(m => m.bbox));
  registerPmtiles('t2-slope', disps.map(m => ({url: m.url, minzoom: m.minzoom ?? 0, maxzoom: m.maxzoom ?? 14, bounds: m.bbox})),
    {tileType: 'raster', composite: true});
  map.addSource('t2-slope', {type: 'raster', tiles: ['skt://tile/t2-slope/{z}/{x}/{y}'], tileSize: disps[0].tileSize || 256, minzoom: minz, maxzoom: maxz, bounds});
  map.addLayer({id: 'slope-t2', type: 'raster', source: 't2-slope', layout: {visibility: 'none'},
    paint: {'raster-resampling': 'nearest', 'raster-fade-duration': 0}}, 'anchor-terrain');
}

function slopeLegend(ctx) {
  const t2 = tier2Info();
  return el('div', {},
    el('div', {class: 'legend'}, SLOPE_CLASSES.filter(c => SLOPE_COLORS[c.id]).map(c =>
      el('span', {}, el('i', {style: `background:${rgb(SLOPE_COLORS[c.id])}`}), `${c.label}°`))),
    el('p', {class: 'small muted'}, 'Below 25° is not shaded. Classes include their lower bound (30.0° is in 30-35). Steepness only: not a hazard rating and not a statement that any slope is safe.'),
    el('p', {class: 'small muted'}, t2?.display
      ? `Tier 2 (USGS 3DEP, 10 m analysis grid) in processed regions; Tier 1 elsewhere, computed in this browser from ${DEM.name} tiles.` +
        `${t2.regions.length ? ' Tap inside a dashed outline for exact Tier 2 10 m values.' : ''}`
      : `Tier 1: computed in this browser from ${DEM.name} tiles.${t2?.regions.length ? ' Tap inside a dashed outline for Tier 2 10 m values.' : ''}`),
    el('p', {class: 'small muted'}, `Tier 1 pixel size follows the zoom: about 29 m at map zoom ${SLOPE_MIN_MAPZOOM}, 15 m at ${SLOPE_MIN_MAPZOOM + 1}, ` +
      `${(29.3 / 4).toFixed(1)} m from ${SLOPE_MIN_MAPZOOM + 2}. Coarser pixels smooth slopes, so zoom in before reading classes. Short steep pitches can read lower than they are.`));
}

const aspectLegend = () => el('div', {},
  el('div', {class: 'legend'}, Object.entries(ASPECT_COLORS).filter(([, c]) => c).map(([k, c]) => el('span', {}, el('i', {style: `background:${rgb(c)}`}), k))),
  el('p', {class: 'small muted'}, 'Direction the slope faces (downslope), 8 sectors. Flat ground (under 1°) is not shaded. Tier 1, computed in this browser; degrees from true north.'));

/** Terrain layer definitions. */
export function terrainLayers() {
  const map = ctx => ctx.map;
  return [
    {id: 'hillshade', group: 'terrain', title: 'Hillshade', defaultOn: true, opacity: 1, mapLayers: ['hillshade'], sources: ['dem'],
      opacityProps: [['hillshade', 'hillshade-exaggeration', 0.45]], info: terrainInfo,
      legend: () => el('p', {class: 'small muted'}, `Shaded relief from ${DEM.name} terrain tiles.`)},
    {id: 'imagery', group: 'terrain', title: 'Aerial imagery (USGS)', defaultOn: false, opacity: 1, mapLayers: ['imagery'], sources: ['imagery'],
      opacityProps: [['imagery', 'raster-opacity']],
      setup: ctx => {
        const m = map(ctx);
        if (m.getSource('imagery')) return;
        const c = CONFIG.imagery;
        m.addSource('imagery', {type: 'raster', tiles: [c.tiles], tileSize: 256, maxzoom: c.maxzoom, bounds: CONFIG.coloradoBbox, attribution: c.attribution});
        m.addLayer({id: 'imagery', type: 'raster', source: 'imagery', layout: {visibility: 'none'}, paint: {'raster-fade-duration': 0}}, 'anchor-terrain');
      },
      legend: () => el('p', {class: 'small muted'}, `${CONFIG.imagery.note} Online only: not included in offline packages.`),
      info: () => ({text: CONFIG.imagery.note, links: [['USGS National Map terms', 'https://www.usgs.gov/faqs/what-are-terms-uselicensing-map-services-and-data-national-map']]})},
    {id: 'contours', group: 'terrain', title: 'Contours', defaultOn: true, opacity: 1, mapLayers: ['contours-minor', 'contours-major', 'contours-label'],
      sources: ['contours'], minzoom: 11, opacityProps: [['contours-minor', 'line-opacity', 0.45], ['contours-major', 'line-opacity', 0.75]], info: terrainInfo,
      legend: () => el('p', {class: 'small muted'}, getUnits() === 'metric'
        ? 'Metres. Intervals: 50 m (zoom 11-12), 20 m (13), 10 m (14+); every fifth line is bold and labeled.'
        : 'Feet. Intervals: 200 ft (zoom 11), 100 ft (12), 40 ft (13-14), 20 ft (15+); every fifth line is bold and labeled.')},
    {id: 'slope', group: 'terrain', title: 'Slope angle', defaultOn: false, opacity: 0.6, minzoom: SLOPE_MIN_MAPZOOM,
      mapLayers: ['slope-t1', 'slope-t2', 't2-outline'], sources: ['slope-t1', 't2-slope'],
      opacityProps: [['slope-t1', 'raster-opacity'], ['slope-t2', 'raster-opacity']],
      chip: () => (tier2Info()?.display ? 'Slope: Tier 2 in processed regions, Tier 1 elsewhere' : 'Slope: Tier 1, computed in browser'),
      setup: async ctx => {
        const m = map(ctx);
        await setupTier2(ctx, m);
        if (!m.getSource('slope-t1')) {
          m.addSource('slope-t1', tier1Source('slope'));
          m.addLayer({id: 'slope-t1', type: 'raster', source: 'slope-t1', layout: {visibility: 'none'},
            paint: {'raster-resampling': 'nearest', 'raster-fade-duration': 0}}, 'anchor-terrain');
        }
      },
      legend: slopeLegend, info: ctx => ({...terrainInfo(), metaUrl: tier2Numerics(ctx)[0]?.meta})},
    {id: 'aspect', group: 'terrain', title: 'Aspect', defaultOn: false, opacity: 0.5, minzoom: SLOPE_MIN_MAPZOOM, mapLayers: ['aspect-t1'], sources: ['aspect-t1'],
      opacityProps: [['aspect-t1', 'raster-opacity']],
      setup: ctx => {
        const m = map(ctx);
        if (m.getSource('aspect-t1')) return;
        m.addSource('aspect-t1', tier1Source('aspect'));
        m.addLayer({id: 'aspect-t1', type: 'raster', source: 'aspect-t1', layout: {visibility: 'none'},
          paint: {'raster-resampling': 'nearest', 'raster-fade-duration': 0}}, 'anchor-terrain');
      },
      legend: aspectLegend, info: terrainInfo}
  ];
}

