// Official forecasts: CAIC forecast zones colored by danger only when the permission-gated adapter is on
// and a zone has a current published rating. Otherwise the layer is unavailable and the official link stays.
import {CONFIG} from '../config.js';
import {el} from '../ui/dom.js';
import {fetchJson} from '../lib/net.js';
import {fmtDateTime} from '../lib/time.js';
import {CAIC, DANGER_NAMES, normalizeZone, officialLink} from '../providers/caic.js';
import {prop} from './common.js';

// North American Public Avalanche Danger Scale colours (official scale; used only for official ratings).
const DANGER_COLORS = ['transparent', '#50b848', '#fff200', '#f7941e', '#ed1c24', '#231f20'];

export function forecastLayers() {
  return [{
    id: 'caic', group: 'forecast', title: 'CAIC forecast zones', defaultOn: false, opacity: 0.45,
    mapLayers: ['caic-fill', 'caic-line'], sources: ['caic'], query: ['caic-fill'], opacityProps: [['caic-fill', 'fill-opacity']],
    unavailable: () => (CONFIG.providers.caic.enabled ? null
      : 'The CAIC forecast feed is switched off until permission is confirmed. Every place card links to the official CAIC forecast.'),
    setup: async ctx => {
      const fc = await fetchJson(CAIC.mapLayer);
      // Validity is re-evaluated every minute, so a zone that expires while the app is open loses its colour.
      const zones = () => ({type: 'FeatureCollection', features: (fc.features || []).map(f => {
        const z = normalizeZone(f, Date.now());
        return {...f, properties: {name: z.name, display: z.display, level: z.dangerLevel ?? 0, validFrom: z.validFrom, validTo: z.validTo, link: z.link}};
      })});
      ctx.map.addSource('caic', {type: 'geojson', data: zones()});
      setInterval(() => ctx.map.getSource('caic')?.setData(zones()), 60000);
      ctx.map.addLayer({id: 'caic-fill', type: 'fill', source: 'caic', layout: {visibility: 'none'},
        paint: {'fill-color': ['match', ['get', 'display'], 'rated', ['to-color', ['at', ['get', 'level'], ['literal', DANGER_COLORS]]], 'transparent']}}, 'anchor-terrain');
      ctx.map.addLayer({id: 'caic-line', type: 'line', source: 'caic', layout: {visibility: 'none'}, paint: {'line-color': '#222', 'line-width': 1.5}}, 'anchor-overlay');
    },
    describe: f => {
      const rated = prop(f, 'display') === 'rated';
      return {title: prop(f, 'name') || 'CAIC zone', badge: 'Official forecast',
        meaning: rated ? `Current rating: ${DANGER_NAMES[prop(f, 'level')]} (highest published level for the zone). Read the full forecast for elevation bands and problems.`
          : `No current rating shown (${prop(f, 'display')}). Missing or expired is not low danger.`,
        lines: [['Valid from', fmtDateTime(prop(f, 'validFrom'))], ['Valid to', fmtDateTime(prop(f, 'validTo'))]],
        links: [['Official CAIC forecast', prop(f, 'link')]]};
    },
    legend: () => el('div', {}, el('div', {class: 'legend'}, DANGER_NAMES.slice(1).map((n, i) => el('span', {}, el('i', {style: `background:${DANGER_COLORS[i + 1]}`}), `${i + 1} ${n}`))),
      el('p', {class: 'small muted'}, 'Colors only for zones with a current published rating. Expired, missing or failed products show no color.')),
    info: () => ({text: 'Colorado Avalanche Information Center forecast zones via the avalanche.org map layer.', links: [['Official CAIC forecast', officialLink(null)]]})
  }];
}

