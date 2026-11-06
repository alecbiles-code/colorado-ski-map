// Snow layers: SNOTEL stations (tap opens the station in Conditions) and SNODAS modeled snow depth / SWE.
import {el} from '../ui/dom.js';
import {CONFIG} from '../config.js';
import {fmtElevation, fmtSnowDepth, fmtWater} from '../lib/units.js';
import {fmtDay, fmtDateTime, localDate} from '../lib/time.js';
import {fetchJson, fetchWithTimeout} from '../lib/net.js';
import {addGeojson, metaInfo, product, prop} from './common.js';

const snotelProduct = ctx => product(ctx, p => p.id === 'snotel-stations');
let stations = new Map(); // id -> original GeoJSON feature (full nested properties)

/* ---------- SNODAS (modeled snow depth and SWE, about 1 km) ---------- */
let snodas = null; // Promise<{meta, metaUrl}>
/** Load the SNODAS meta from the generated-data base first (github.io), then this site. */
export function loadSnodas() {
  const urls = [CONFIG.generatedBase && CONFIG.generatedBase + CONFIG.snodasMetaPath, `./${CONFIG.snodasMetaPath}`].filter(Boolean)
    .map(u => new URL(u, document.baseURI).href);
  snodas ||= (async () => {
    for (const u of urls) {
      try { return {meta: await fetchJson(u, {cache: 'no-cache', retries: 0}), metaUrl: u}; } catch { /* next */ }
    }
    snodas = null;
    throw new Error('SNODAS metadata unavailable');
  })();
  return snodas;
}
const snodasListed = ctx => product(ctx, p => /snodas/i.test(p.id));
/** Days the analysis date lags today's Colorado date (null if unknown). */
const lagDays = date => (date ? Math.round((Date.parse(`${localDate()}T00:00:00Z`) - Date.parse(`${date}T00:00:00Z`)) / 86400000) : null);
const fmtBin = (b, variable) => {
  const f = variable === 'swe' ? mm => fmtWater(mm) : mm => fmtSnowDepth(mm / 10);
  return b.maxMmInclusive === null ? `over ${f(b.minMmExclusive)}` : `${f(b.minMmExclusive)} to ${f(b.maxMmInclusive)}`;
};

function snodasLayer(variable, key, title) {
  const id = `snodas-${variable}`;
  return {
    id, group: 'snow', title, defaultOn: false, opacity: 0.65, mapLayers: [id], sources: [id], opacityProps: [[id, 'raster-opacity']],
    unavailable: ctx => (snodasListed(ctx) ? null : 'The SNODAS Colorado product has not been published yet.'),
    setup: async ctx => {
      const {meta, metaUrl} = await loadSnodas();
      const layer = meta.layers?.[key];
      if (!layer) throw new Error(`SNODAS meta has no ${key} layer`);
      if (!ctx.map.getSource(id)) ctx.map.addSource(id, {type: 'image', url: new URL(layer.url, metaUrl).href, coordinates: layer.coordinates});
      if (!ctx.map.getLayer(id)) ctx.map.addLayer({id, type: 'raster', source: id, layout: {visibility: 'none'}, paint: {'raster-resampling': 'nearest', 'raster-fade-duration': 0}}, 'anchor-terrain');
      ctx.snodasLoaded = {meta, metaUrl};
    },
    chip: ctx => {
      const d = ctx.snodasLoaded?.meta.analysisDate;
      const lag = lagDays(d);
      return d ? `SNODAS ${title.replace('SNODAS ', '')}: ${fmtDay(`${d}T12:00:00Z`)}${lag > 2 ? ` (${lag} days old)` : ''}` : null;
    },
    legend: ctx => {
      const m = ctx.snodasLoaded?.meta;
      if (!m) return el('p', {class: 'small muted'}, 'Turn on to load the latest analysis.');
      const bins = m.layers[key].legend || [];
      const lag = lagDays(m.analysisDate);
      return el('div', {},
        el('p', {class: lag > 2 ? 'note small' : 'small'}, `Analysis date ${fmtDay(`${m.analysisDate}T12:00:00Z`)} (snowpack at ${fmtDateTime(m.validFrom)}).`,
          lag > 2 ? ` ${lag} days old: newer analyses may be late or missing.` : ''),
        el('div', {class: 'legend'}, bins.map(b => el('span', {}, el('i', {style: `background:${b.color || 'transparent'}`}),
          b.state === 'value' ? fmtBin(b, variable) : b.label))),
        el('p', {class: 'small muted'}, `${variable === 'swe' ? 'Snow water equivalent of the whole snowpack' : 'Depth of the whole snowpack'}, modeled at about 1 km. Not new snow, not ski-line scale, and says nothing about avalanche danger.`));
    },
    info: ctx => metaInfo(ctx.snodasLoaded?.meta || ctx.metas.get(snodasListed(ctx)?.id), {metaUrl: snodasListed(ctx)?.meta,
      text: 'NOAA NOHRSC SNODAS via NSIDC G02158: daily modeled snow analysis that assimilates observations into a snow model.'})
  };
}

/** SNODAS values in the 30 arc-second cell under a point (from the numeric grid), or null outside it. */
export async function sampleSnodas(lon, lat) {
  const {meta, metaUrl} = await loadSnodas();
  const g = meta.grid;
  const col = Math.floor((lon - g.west) / g.cellDeg); const row = Math.floor((g.north - lat) / g.cellDeg);
  if (col < 0 || row < 0 || col >= g.cols || row >= g.rows) return null;
  const r = Math.floor(row / g.chunkCells); const c = Math.floor(col / g.chunkCells);
  const url = new URL(g.chunkUrl.replace('{r}', r).replace('{c}', c), metaUrl).href;
  const buf = await (await fetchWithTimeout(url)).arrayBuffer();
  const dv = new DataView(buf);
  const off = 4 * ((row % g.chunkCells) * g.chunkCells + (col % g.chunkCells));
  const read = o => { const v = dv.getInt16(o, true); return v === g.nodata || v === g.saturated ? null : v; };
  return {depthMm: read(off), sweMm: read(off + 2), analysisDate: meta.analysisDate, validFrom: meta.validFrom};
}

export function snowLayers() {
  return [
    {id: 'snotel', group: 'snow', title: 'SNOTEL stations', defaultOn: false, opacity: null, mapLayers: ['snotel-dot', 'snotel-label'], sources: ['snotel'],
      query: ['snotel-dot'],
      unavailable: ctx => (snotelProduct(ctx) ? null : 'Station list not published yet.'),
      setup: async ctx => {
        const p = snotelProduct(ctx);
        const data = await addGeojson(ctx.map, 'snotel', p.url || 'data/snow/snotel-stations.geojson');
        stations = new Map(data.features.map(f => [f.id ?? f.properties.id, f]));
        ctx.map.addLayer({id: 'snotel-dot', type: 'circle', source: 'snotel', layout: {visibility: 'none'},
          paint: {'circle-radius': ['interpolate', ['linear'], ['zoom'], 6, 4, 12, 8], 'circle-color': '#1565c0', 'circle-stroke-color': '#fff', 'circle-stroke-width': 2}}, 'anchor-overlay');
        ctx.map.addLayer({id: 'snotel-label', type: 'symbol', source: 'snotel', minzoom: 9, layout: {visibility: 'none', 'text-field': ['get', 'name'],
          'text-font': ['Noto Sans Medium'], 'text-size': 12, 'text-offset': [0, 1.1], 'text-anchor': 'top', 'text-optional': true},
        paint: {'text-color': '#0d3c7a', 'text-halo-color': '#fff', 'text-halo-width': 1.5}});
      },
      toPlace: f => {
        const full = stations.get(prop(f, 'id')) || f;
        const [lon, lat] = full.geometry.coordinates;
        return {name: `${full.properties.name} SNOTEL`, station: full, stationLon: lon, stationLat: lat};
      },
      describe: f => ({title: `${prop(f, 'name')} (${prop(f, 'networkName') || 'SNOTEL'})`, badge: 'Observation',
        meaning: 'Automated NRCS station measuring snow and weather at one point in a clearing. Not necessarily representative of nearby alpine or wind-loaded terrain.',
        lines: [['Station', prop(f, 'upstreamId')], ['Elevation', fmtElevation(prop(f, 'elevationM'))], ['County', prop(f, 'county')]],
        links: [['NRCS station page', prop(f, 'sourceUrl')]]}),
      legend: () => el('div', {class: 'legend'}, el('span', {}, el('i', {class: 'dot', style: 'background:#1565c0;border:2px solid #fff'}), 'Station (tap for data in Conditions)')),
      info: ctx => metaInfo(ctx.metas.get('snotel-stations'), {metaUrl: snotelProduct(ctx)?.meta})},
    snodasLayer('depth', 'snow_depth', 'SNODAS snow depth'),
    snodasLayer('swe', 'swe', 'SNODAS snow water equivalent')
  ];
}
