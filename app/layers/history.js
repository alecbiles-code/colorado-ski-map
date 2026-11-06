// Historical observations: experimental SAR avalanche candidates (seasonal and cross-season hotspots,
// remote PMTiles from the avalanche-inventory app) and documented avalanche incidents. These stay visually
// distinct from each other and from modeled terrain and forecasts.
import {CONFIG} from '../config.js';
import {el, link} from '../ui/dom.js';
import {fmtDay} from '../lib/time.js';
import {registerPmtiles} from '../map/tiles.js';
import {addGeojson, addProductSource, metaInfo, product, prop} from './common.js';

const SAR_CHIP = 'Experimental SAR avalanche candidates';
const SEASONS = ['2021-2022', '2022-2023', '2023-2024'];
const sarProduct = ctx => product(ctx, p => p.group === 'history' && /sar/i.test(p.id));
const sarMeta = ctx => ctx.metas.get(sarProduct(ctx)?.id) || null;
// SAR colour family (violet seasonal, cyan hotspots): distinct from danger-scale, slope-class, model and incident colours.
const SAR_COLORS = {seasonal: {fill: '#c4b5fd', line: '#7c3aed'}, hotspots: {fill: '#22d3ee', line: '#0e7490'}};
const incidentsProduct = ctx => product(ctx, p => p.group === 'history' && /incident/i.test(`${p.id} ${p.kind || ''}`) && p.url);
let seasonFilter = new Set(SEASONS);

const SAR_MEANING = 'Candidate debris detected by Sentinel-1 radar change detection (about 20 m). Not a confirmed avalanche, not a current hazard and not a probability. ' +
  '"Confidence" is the inventory’s own detection class, not a calibrated probability.';

/** SAR coverage outline: inside the box the radar was analysed; outside it there is no data. */
async function addSarCoverage(map) {
  if (map.getSource('sar-coverage')) return;
  await addGeojson(map, 'sar-coverage', 'data/sar/coverage.geojson');
  if (map.getLayer('sar-coverage-line')) return; // the other SAR layer's setup finished first
  map.addLayer({id: 'sar-coverage-line', type: 'line', source: 'sar-coverage', layout: {visibility: 'none'},
    paint: {'line-color': '#7c3aed', 'line-width': 2, 'line-dasharray': [1, 1.5]}}, 'anchor-overlay');
}

function sarLayer(kind) {
  const seasonal = kind === 'seasonal';
  const id = seasonal ? 'sar-seasonal' : 'sar-hotspots';
  const file = seasonal ? CONFIG.sar.seasonal : CONFIG.sar.hotspots;
  const col = SAR_COLORS[seasonal ? 'seasonal' : 'hotspots'];
  const archive = ctx => sarMeta(ctx)?.archives?.find(a => a.file === file) || {};
  return {
    id, group: 'history', title: seasonal ? 'SAR avalanche candidates by season' : 'SAR cross-season hotspots', defaultOn: false, opacity: 0.8,
    minzoom: seasonal ? 11 : 12,
    chip: SAR_CHIP, mapLayers: [`${id}-fill`, `${id}-line`], sources: [id], query: [`${id}-fill`],
    onToggle: ctx => {
      const any = ['sar-seasonal', 'sar-hotspots'].some(i => ctx.reg?.state.get(i)?.on);
      if (ctx.map.getLayer('sar-coverage-line')) ctx.map.setLayoutProperty('sar-coverage-line', 'visibility', any ? 'visible' : 'none');
    },
    opacityProps: [[`${id}-fill`, 'fill-opacity', 0.5], [`${id}-line`, 'line-opacity']],
    setup: async ctx => {
      const m = ctx.map;
      await addSarCoverage(m);
      if (m.getSource(id)) return;
      // Recommended min zoom from the inventory audit: low-zoom tiles are several MB (hotspots reach 5.4 MB at z9).
      const a = archive(ctx);
      const minzoom = a.recommendedMinzoom ?? (seasonal ? 11 : 12);
      registerPmtiles(id, [{url: CONFIG.sar.baseUrl + file, minzoom: a.minzoom ?? 5, maxzoom: a.maxzoom ?? 14, bounds: a.bounds}], {tileType: 'vector'});
      m.addSource(id, {type: 'vector', tiles: [`skt://tile/${id}/{z}/{x}/{y}`], minzoom, maxzoom: a.maxzoom ?? 14, ...(a.bounds ? {bounds: a.bounds} : {})});
      const layer = seasonal ? 'avalanches' : 'hotspots';
      const hi = ['==', ['get', 'confidence'], 'higher confidence'];
      m.addLayer({id: `${id}-fill`, type: 'fill', source: id, 'source-layer': layer, layout: {visibility: 'none'},
        paint: {'fill-color': col.fill, 'fill-opacity': ['case', hi, 0.45, 0.12]}}, 'anchor-overlay');
      m.addLayer({id: `${id}-line`, type: 'line', source: id, 'source-layer': layer, layout: {visibility: 'none'},
        paint: {'line-color': col.line, 'line-width': ['case', hi, 1.6, 0.8]}}, 'anchor-overlay');
      if (seasonal) applySeasonFilter(m);
    },
    describe: f => ({title: prop(f, 'event_id') || 'SAR candidate', badge: SAR_CHIP, badgeClass: 'exp', meaning: SAR_MEANING,
      lines: [['Season', seasonal ? `${prop(f, 'season')} winter (Jan 1 to Apr 30 analysed; no event date exists)` : 'Recurs across winters 2021-22 to 2023-24 (no dates)'],
        ['Detection class', `${prop(f, 'confidence')} (hand-assigned strength class, not a probability)`],
        ['Area', prop(f, 'Area_m2') === null ? 'n/a' : `${(prop(f, 'Area_m2') / 10000).toFixed(2)} ha`], ['Sensor', 'Sentinel-1 C-band SAR, descending orbit']],
      links: [['Avalanche inventory app and method', CONFIG.sar.appUrl]]}),
    legend: ctx => el('div', {},
      el('p', {class: 'note exp small'}, `${SAR_CHIP}. Front Range study box only (dashed violet outline): outside it there is no data, not an absence of avalanches. Visible from zoom ${seasonal ? 11 : 12}.`),
      el('div', {class: 'legend'}, el('span', {}, el('i', {style: `background:${col.fill};border:2px solid ${col.line}`}), 'Higher detection class'),
        el('span', {}, el('i', {style: `background:${col.fill}44;border:1px solid ${col.line}`}), 'Lower detection class')),
      seasonal ? seasonPicker(ctx) : null),
    info: ctx => metaInfo(sarMeta(ctx), {metaUrl: sarProduct(ctx)?.meta,
      text: 'Sentinel-1 SAR change-detection inventory by the captain (alecbiles-code/avalanche-inventory), winters 2021-22 to 2023-24, Front Range study box.',
      links: [['Avalanche inventory', CONFIG.sar.repoUrl]]})
  };
}

function applySeasonFilter(map) {
  if (!map.getLayer('sar-seasonal-fill')) return;
  const f = seasonFilter.size === SEASONS.length ? null : ['in', ['get', 'season'], ['literal', [...seasonFilter]]];
  map.setFilter('sar-seasonal-fill', f);
  map.setFilter('sar-seasonal-line', f);
}

function seasonPicker(ctx) {
  return el('fieldset', {class: 'row small', style: 'border:0;padding:0;margin:6px 0'}, el('legend', {class: 'muted'}, 'Seasons'),
    SEASONS.map(s => {
      const input = el('input', {type: 'checkbox', onchange: e => { e.target.checked ? seasonFilter.add(s) : seasonFilter.delete(s); applySeasonFilter(ctx.map); }});
      input.checked = seasonFilter.has(s);
      return el('label', {class: 'btn', style: 'font-weight:500'}, input, s);
    }));
}

const killed = f => Number(prop(f, 'killed') ?? prop(f, 'numKilled') ?? NaN);

function incidentsLayer() {
  return {
    id: 'incidents', group: 'history', title: 'Avalanche accidents', defaultOn: false, opacity: null,
    mapLayers: ['incidents-dot'], sources: ['incidents'], query: ['incidents-dot'],
    unavailable: ctx => {
      const p = incidentsProduct(ctx);
      const n = p ? ctx.metas.get(p.id)?.featureCount : 0;
      return n > 0 ? null : 'No authorized accident dataset is loaded (CAIC terms require written permission to reproduce records). This does not mean there were no accidents. Use the official records:';
    },
    unavailableNode: ctx => officialLinksNode(ctx),
    setup: async ctx => {
      const p = incidentsProduct(ctx);
      const meta = ctx.metas.get(p.id) || await ctx.meta(p.id);
      const src = await addProductSource(ctx.map, 'incidents', p, meta);
      const fatal = ['>', ['to-number', ['coalesce', ['get', 'killed'], ['get', 'numKilled'], 0]], 0];
      ctx.map.addLayer({id: 'incidents-dot', type: 'circle', source: 'incidents', ...(src.sourceLayer && src.kind === 'vector' ? {'source-layer': src.sourceLayer} : {}),
        layout: {visibility: 'none'}, paint: {'circle-radius': ['case', fatal, 7, 5], 'circle-color': ['case', fatal, '#111111', '#7d7d7d'],
          'circle-stroke-color': '#ffffff', 'circle-stroke-width': ['case', fatal, 2.5, 1.5]}}, 'anchor-overlay');
    },
    describe: f => {
      const k = killed(f);
      return {title: prop(f, 'name') || prop(f, 'place') || 'Avalanche accident', badge: k > 0 ? 'Fatal' : 'Non-fatal', badgeClass: k > 0 ? 'fatal' : '',
        meaning: 'A documented avalanche accident. Shown for terrain context and lessons; the absence of a marker never means low risk.',
        lines: [['Date', prop(f, 'date') ? fmtDay(prop(f, 'date')) : null], ['Activity', prop(f, 'activity')],
          ['Caught / injured / killed', [prop(f, 'caught'), prop(f, 'injured'), prop(f, 'killed')].map(v => v ?? 'n/a').join(' / ')],
          ['Report status', prop(f, 'reportStatus')], ['Location means', prop(f, 'positionMeaning')],
          ['Position uncertainty', prop(f, 'positionUncertaintyM') === null ? null : `about ${prop(f, 'positionUncertaintyM')} m`]],
        links: [['Official report', prop(f, 'sourceUrl')]]};
    },
    legend: () => el('div', {class: 'legend'}, el('span', {}, el('i', {class: 'dot', style: 'background:#111;border:2px solid #fff'}), 'Fatal accident'),
      el('span', {}, el('i', {class: 'dot', style: 'background:#7d7d7d;border:2px solid #fff'}), 'Non-fatal accident')),
    info: ctx => metaInfo(ctx.metas.get(incidentsProduct(ctx)?.id), {metaUrl: incidentsProduct(ctx)?.meta,
      links: [['CAIC accident reports', CONFIG.providers.officialLinks.caicAccidents]]})
  };
}

/** Official accident record links (data/incidents/official-links.json), shown wherever incidents would be. */
export function officialLinksNode(ctx, limit = 6) {
  const links = (ctx.officialLinks || []).filter(l => l.id !== 'caic-terms' && l.id !== 'caic-contact' && l.id !== 'caic-report-pattern').slice(0, limit);
  if (!links.length) return el('div', {class: 'small'}, link(CONFIG.providers.officialLinks.caicAccidents, 'CAIC: Colorado avalanche accidents'));
  return el('ul', {class: 'small', style: 'margin:4px 0;padding-left:18px'}, links.map(l => el('li', {}, link(l.url, l.title))));
}

export function historyLayers() {
  return [sarLayer('seasonal'), sarLayer('hotspots'), incidentsLayer()];
}
