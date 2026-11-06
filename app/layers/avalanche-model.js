// Modeled avalanche terrain: potential release areas (PRA) and runout from the avalanche-model lane's pilot
// (raster PNG PMTiles with baked colours, a coverage GeoJSON, and a numeric product for tap values).
// Always labeled "Experimental terrain model". Never combined with weather or forecasts; absence of modeled
// release terrain or runout is not evidence of safety.
import {el} from '../ui/dom.js';
import {addGeojson, addProductSource, metaInfo, product} from './common.js';
import {getSet, getTile, registerPmtiles} from '../map/tiles.js';
import {decodeNumericTile, numericCellAt} from '../lib/terrain-math.js';

const CHIP = 'Experimental terrain model';
const find = (ctx, re) => product(ctx, p => p.group === 'avalanche' && re.test(p.id) && p.url && /\.pmtiles$/.test(p.url) && !/numeric/.test(p.id));
const numericProduct = ctx => product(ctx, p => p.group === 'avalanche' && /numeric/.test(p.id));
const COVERAGE_URL = 'data/avalanche/avalanche-coverage-pilot.geojson'; // used when the meta has no coverageFile

/**
 * Pilot extent (outside = not modeled) and the truncation band where runout may be incomplete. The pipeline
 * keeps the feature names in the top-level GeoJSON id and the kind in properties.role
 * ('model_extent' | 'truncation_band'), so filters use role.
 */
async function addCoverage(map, url = COVERAGE_URL) {
  if (map.getSource('avy-coverage')) return;
  await addGeojson(map, 'avy-coverage', url).catch(() => null);
  if (!map.getSource('avy-coverage') || map.getLayer('avy-coverage-line')) return; // missing, or the other model layer added it
  const band = ['==', ['get', 'role'], 'truncation_band'];
  map.addLayer({id: 'avy-coverage-line', type: 'line', source: 'avy-coverage', filter: ['==', ['get', 'role'], 'model_extent'], layout: {visibility: 'none'},
    paint: {'line-color': '#9d174d', 'line-width': 2.5}}, 'anchor-overlay');
  map.addLayer({id: 'avy-band-line', type: 'line', source: 'avy-coverage', filter: band, layout: {visibility: 'none'},
    paint: {'line-color': '#9d174d', 'line-width': 1.2, 'line-dasharray': [2, 2]}}, 'anchor-overlay');
  map.addLayer({id: 'avy-coverage-label', type: 'symbol', source: 'avy-coverage', filter: band,
    layout: {visibility: 'none', 'symbol-placement': 'line', 'text-field': 'runout incomplete', 'text-font': ['Noto Sans Italic'], 'text-size': 11},
    paint: {'text-color': '#9d174d', 'text-halo-color': '#fff', 'text-halo-width': 1.5}});
}

/** Truncation band explanation with its width from the meta (truncationBand.widthM). */
function coverageNote(meta) {
  const w = meta.truncationBand?.widthM;
  return 'Pilot area only (solid outline): outside it nothing was modeled. ' +
    `${Number.isFinite(w) ? `Within ${(w / 1000).toFixed(1)} km of the pilot edge` : 'Near the pilot edge'} (dashed band, "runout incomplete") ` +
    'paths from release terrain outside the pilot are missing and paths leaving it are cut.';
}

/**
 * One modeled layer. meaning(meta) words the method from the product's meta file; the legend swatches are the
 * meta's legend.items (the colours baked into the tiles), falling back to its classes.
 */
function modelLayer({id, title, re, meaning}) {
  return {
    id, group: 'avalanche', title, defaultOn: false, opacity: 0.65, chip: CHIP,
    mapLayers: [`${id}-raster`], sources: [id], opacityProps: [[`${id}-raster`, 'raster-opacity']],
    onToggle: ctx => {
      const any = ['pra', 'runout'].some(i => ctx.reg?.state.get(i)?.on);
      for (const l of ['avy-coverage-line', 'avy-band-line', 'avy-coverage-label']) if (ctx.map.getLayer(l)) ctx.map.setLayoutProperty(l, 'visibility', any ? 'visible' : 'none');
    },
    unavailable: ctx => (find(ctx, re) ? null : 'The avalanche terrain model pilot has not been published yet.'),
    setup: async ctx => {
      const p = find(ctx, re);
      const meta = ctx.metas.get(p.id) || await ctx.meta(p.id);
      await addCoverage(ctx.map, meta.coverageFile);
      await addProductSource(ctx.map, id, p, {tileType: 'png', ...meta});
      if (!ctx.map.getLayer(`${id}-raster`)) ctx.map.addLayer({id: `${id}-raster`, type: 'raster', source: id, layout: {visibility: 'none'},
        paint: {'raster-resampling': 'nearest', 'raster-fade-duration': 0}}, 'anchor-terrain');
    },
    legend: ctx => {
      const meta = ctx.metas.get(find(ctx, re)?.id) || {};
      const items = (meta.legend?.items || meta.classes || []).filter(c => c.color);
      const defaults = (meta.limitations || []).find(t => /default/i.test(t));
      return el('div', {},
        el('p', {class: 'note exp small'}, `${CHIP}. ${meaning(meta)}`),
        el('div', {class: 'legend'}, items.map(c => el('span', {}, el('i', {style: `background:${c.color}`}), c.label || c.id))),
        defaults ? el('p', {class: 'small muted'}, defaults) : null,
        el('p', {class: 'small muted'}, coverageNote(meta)));
    },
    info: ctx => metaInfo(ctx.metas.get(find(ctx, re)?.id), {metaUrl: find(ctx, re)?.meta})
  };
}

/** Text for a bit-field value: the meanings of the set bits (meta `bits`: {bitIndex: meaning}). */
const bitText = (n, bits) => Object.entries(bits).filter(([b]) => (n >> Number(b)) & 1).map(([, t]) => t).join('; ') || 'no flags set';

/**
 * Tap values from the numeric product for every variable, or null when the product is missing.
 * meta.numeric.variables is a list of {name, tileZ, scale, unit, notReached?, bits?, meaning?} (an object keyed by
 * name is also accepted). Each value is {label, value, text, unit, state: 'value'|'notReached'|'nodata'|'outside'};
 * bit fields carry `text` (the set flags) instead of a number.
 */
export async function inspectAvalanche(ctx, lon, lat) {
  const p = numericProduct(ctx);
  if (!p) return null;
  const meta = ctx.metas.get(p.id) || await ctx.meta(p.id);
  const num = meta.numeric;
  if (!num?.variables) return null;
  if (!getSet('avy-num')) registerPmtiles('avy-num', [{url: meta.url || p.url, minzoom: 0, maxzoom: 22}], {tileType: 'numeric'});
  const vars = Array.isArray(num.variables) ? num.variables.map(v => [v.name, v]) : Object.entries(num.variables);
  const out = [];
  for (const [key, v] of vars) {
    const label = v.label || key;
    const cell = numericCellAt(lon, lat, {...num, tileZ: v.tileZ});
    if (!cell) { out.push({key, label, state: 'outside'}); continue; }
    const r = await getTile('avy-num', cell.z, cell.x, cell.y);
    if (!r.data) { out.push({key, label, state: 'nodata'}); continue; }
    const side = num.blockCells + 2 * (num.apronCells || 0);
    const n = (await decodeNumericTile(new Uint8Array(r.data), side))[cell.row * side + cell.col];
    const state = n === (v.notReached ?? num.notReached) ? 'notReached' : n === (v.nodata ?? num.nodata) ? 'nodata' : 'value';
    const value = state === 'value' && !v.bits ? n / (v.scale ?? num.scale ?? 1) : null;
    const text = state === 'value' && v.bits ? bitText(n, v.bits) : null;
    out.push({key, label, unit: v.bits ? '' : v.unit || '', state, value, text, meaning: v.meaning || v.description || ''});
  }
  return out;
}

export function avalancheModelLayers() {
  return [
    modelLayer({id: 'pra', title: 'Potential release areas', re: /pra/i,
      meaning: m => `Terrain the model scores as able to start an avalanche, by ${m.model?.pra?.method || 'the pilot release-area model'}. ` +
        'A terrain-suitability score: not a release probability, not current danger, and unshaded terrain is not safe.'}),
    modelLayer({id: 'runout', title: 'Modeled runout', re: /runout/i,
      meaning: m => {
        const r = m.model?.runout; const a = r?.parameters?.alpha_deg;
        return `Where flow from modeled release areas can travel (${r?.software || 'Flow-Py'}${r?.version ? ` ${r.version}` : ''}` +
          `${Number.isFinite(a) ? `, angle of reach ${a}°` : ''}). Shows terrain exposure, not reach probability, timing, speed or burial depth.`;
      }})
  ];
}
