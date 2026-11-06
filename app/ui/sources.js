// Sources and Methods: plain-language provenance and limitations per product, generated from the meta
// files, with technical detail on demand.
import {CONFIG} from '../config.js';
import {el, kv, link} from './dom.js';
import {GROUPS} from '../map/layers.js';
import {fmtDateTime} from '../lib/time.js';
import {fmtBytes} from '../offline/planner.js';
import {safeUrl} from '../lib/escape.js';
import {DEM} from '../map/terrain.js';

const docLink = path => (path ? link(new URL(`./${String(path).replace(/^\.?\//, '')}`, document.baseURI).href, path) : null);

function productCard(p, meta) {
  if (!meta) return el('div', {class: 'card'}, el('h4', {}, p.title), el('p', {class: 'small muted'}, 'Metadata could not be loaded.'));
  const r = meta.analysisGrid?.resM ?? meta.resolutionM ?? meta.resolution;
  const res = Number.isFinite(r) ? `${r} m` : typeof r?.nominal === 'string' ? r.nominal : null; // SNODAS gives {cellArcSec, nominal}
  return el('div', {class: 'card'},
    el('h4', {}, meta.title || p.title),
    meta.description ? el('p', {class: 'small'}, meta.description) : null,
    kv([['Processed', meta.processedAt || meta.processing?.processedAt ? fmtDateTime(meta.processedAt || meta.processing.processedAt) : null],
      ['Coverage', (meta.bbox || meta.coverage?.bbox)?.map(v => Number(v).toFixed(2)).join(', ')], ['Resolution', res],
      ['Size', p.bytes ? fmtBytes(p.bytes) : null], ['Licenses', [...new Set((meta.sources || []).map(s => s.license).filter(Boolean))].join('; ')]]),
    (meta.limitations || []).length ? el('ul', {class: 'small'}, meta.limitations.map(t => el('li', {}, String(t)))) : null,
    el('div', {class: 'small'}, (meta.sources || []).map(s => el('div', {}, safeUrl(s.landingPage || s.url) ? link(s.landingPage || s.url, s.name || 'Source') : s.name))),
    meta.methods ? el('div', {class: 'small'}, 'Method: ', docLink(meta.methods)) : null,
    el('details', {}, el('summary', {}, 'Technical detail'),
      el('pre', {class: 'small', style: 'white-space:pre-wrap;overflow-wrap:anywhere;max-height:320px;overflow:auto'},
        JSON.stringify({id: meta.id, kind: meta.kind, crs: meta.crs || meta.analysisGrid?.crs, units: meta.units, processing: meta.processing, numeric: meta.numeric}, null, 1)),
      link(new URL(`./${p.meta}`, document.baseURI).href, 'Full metadata (JSON)')));
}

const STACK = [
  ['Map rendering', 'MapLibre GL JS 5.24.0 (BSD-3-Clause), PMTiles 4.5.0 (BSD-3-Clause), maplibre-contour 0.1.1 (BSD-3-Clause), self-hosted in vendor/.'],
  ['Basemap style', 'Our topo style generated from @protomaps/basemaps 5.7.2 (BSD-3-Clause) layers for the Protomaps v4 schema. Map data OpenStreetMap contributors (ODbL).'],
  ['Fonts and icons', 'Noto Sans glyphs (SIL Open Font License 1.1) and the Protomaps v4 sprite (derived from MIT-licensed tangrams/icons), from protomaps/basemaps-assets.'],
  ['Terrain, two tiers', `Tier 1 (statewide, approximate): ${DEM.name} terrain tiles (${DEM.sourceNote}), slope and aspect computed in this browser with Horn 3x3 on the Web Mercator grid using the true ground pixel size per row. Tier 2 (pilot, analytical): USGS 3DEP 1/3 arc-second resampled to a 10 m UTM 13N grid; the inspector decodes those numbers exactly. The inspector always says which tier it used.`],
  ['What terrain layers mean', 'Slope classes, aspect, release areas and runout describe terrain only. They are not a hazard rating, never a statement that a slope is safe, and are never combined with weather or forecasts into a recommendation.'],
  ['Your data', 'Saved places, notes, imported routes and offline areas stay in this browser (IndexedDB and Cache Storage named skintrack-*). Nothing personal is uploaded. Location is used only on this device.']
];

/** Render the view. */
export function renderSources(ctx) {
  const root = el('div', {},
    el('section', {class: 'section'}, el('h3', {}, 'How this map works'), ...STACK.map(([h, t]) => el('div', {class: 'card'}, el('h4', {}, h), el('p', {class: 'small'}, t)))),
    el('section', {class: 'section'}, el('h3', {}, 'Official sources to check'),
      el('div', {class: 'row'}, link(CONFIG.providers.officialLinks.caicForecast, 'CAIC forecast'), link(CONFIG.providers.officialLinks.caicAccidents, 'CAIC accidents'), link(CONFIG.providers.officialLinks.nws, 'National Weather Service'))),
    el('section', {class: 'section'}, el('h3', {}, 'Project documents'),
      el('div', {class: 'small'}, ['docs/ARCHITECTURE.md', 'docs/SOURCES.md', 'docs/METHODS.md', 'docs/COVERAGE.md', 'docs/VERIFICATION.md'].map(p => el('div', {}, docLink(p))))));
  const products = el('div', {}, el('p', {class: 'muted'}, 'Loading product metadata…'));
  root.append(el('section', {class: 'section'}, el('h3', {}, 'Data products'), products));
  Promise.all(ctx.products.map(p => ctx.meta(p.id).catch(() => null))).then(metas => {
    const order = Object.fromEntries([['base', -1], ...GROUPS.map(([g], i) => [g, i])]);
    const rows = ctx.products.map((p, i) => [p, metas[i]]).sort((a, b) => (order[a[0].group] ?? 99) - (order[b[0].group] ?? 99));
    products.replaceChildren(...(rows.length ? rows.map(([p, m]) => productCard(p, m)) : [el('p', {class: 'note'}, 'The product index (data/manifest.json) could not be loaded.')]));
  });
  return root;
}
