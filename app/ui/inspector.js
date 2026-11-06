// Place card and inspector: what is under a tapped point (terrain numbers with tier and source, every
// overlapping feature with its meaning and source), plus the conditions summary and actions.
import {el, kv, link} from './dom.js';
import {inspectTerrain} from '../map/terrain.js';
import {aspectName, slopeClass} from '../lib/terrain-math.js';
import {sampleSnodas} from '../layers/snow.js';
import {inspectAvalanche} from '../layers/avalanche-model.js';
import {fmtElevation, fmtAngle, fmtSnowDepth, fmtWater} from '../lib/units.js';
import {fmtDay} from '../lib/time.js';

/** "39.75000, -105.81000" (lat, lon order for people; data stays [lon, lat]). */
export const fmtLatLon = (lon, lat) => `${lat.toFixed(5)}, ${lon.toFixed(5)}`;

function terrainBlock(t) {
  if (!t) return el('p', {class: 'muted'}, 'Reading terrain…');
  if (t.error) return el('p', {class: 'note'}, t.error);
  const cls = t.slopeDeg === null ? null : slopeClass(t.slopeDeg);
  const asp = t.aspectDeg === null ? 'n/a' : t.aspectDeg < 0 ? 'Flat (under 1°)' : `${aspectName(t.aspectDeg, 16)} (${fmtAngle(t.aspectDeg)})`;
  return el('div', {},
    kv([['Elevation', fmtElevation(t.elevationM)],
      ['Slope', t.slopeDeg === null ? 'n/a' : `${fmtAngle(t.slopeDeg)}${cls ? ` (class ${cls.label}°)` : ''}`],
      ['Aspect', asp]]),
    el('p', {class: 'small muted'}, el('span', {class: `badge${t.tier === 2 ? ' ok' : ''}`}, `Tier ${t.tier}`), ' ', t.source,
      t.resolutionM ? `, about ${t.resolutionM.toFixed(1)} m cells` : '', '. Aspect: degrees clockwise from true north.',
      t.tier === 1 ? ' Approximate: short steep pitches can read lower than they are.' : ''));
}

/** Group features returned by queryRenderedFeatures under their layer definitions, deduplicated. */
export function featuresAt(map, reg, point) {
  const defs = reg.visible().filter(d => d.query?.length);
  const layers = defs.flatMap(d => d.query).filter(id => map.getLayer(id));
  if (!layers.length) return [];
  const r = 14;
  const hits = map.queryRenderedFeatures([[point.x - r, point.y - r], [point.x + r, point.y + r]], {layers});
  const seen = new Set();
  const out = [];
  for (const f of hits) {
    const d = defs.find(x => x.query.includes(f.layer.id));
    const key = `${d.id}:${f.id ?? f.properties?.id ?? JSON.stringify(f.properties).slice(0, 200)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({def: d, feature: f});
  }
  return out.slice(0, 25);
}

function featureCard({def, feature}, ctx) {
  const c = def.describe?.(feature, ctx) || {title: def.title, lines: []};
  return el('div', {class: 'card'},
    el('h4', {}, c.title || def.title, ' ', c.badge ? el('span', {class: `badge ${c.badgeClass || ''}`}, c.badge) : null),
    c.meaning ? el('p', {class: 'small muted'}, c.meaning) : null,
    c.lines?.length ? kv(c.lines) : null,
    c.node || null,
    el('div', {class: 'row small'}, (c.links || []).map(([t, u]) => link(u, t))));
}

/**
 * Render the place card into a fresh node. Async parts (terrain, conditions summary) fill in later.
 * @param {{place: object, features: Array, ctx: object, actions: object}} o
 */
export function renderPlaceCard({place, features, ctx, actions}) {
  const terrainSlot = el('div', {}, terrainBlock(null));
  const summarySlot = el('div', {class: 'section'});
  const root = el('div', {},
    el('p', {class: 'small muted'}, fmtLatLon(place.lon, place.lat), place.sub ? ` · ${place.sub}` : ''),
    el('div', {class: 'row', style: 'margin:6px 0 12px'},
      el('button', {class: 'btn primary', type: 'button', onclick: actions.conditions}, 'Conditions'),
      el('button', {class: 'btn', type: 'button', onclick: actions.save}, actions.isSaved ? 'Saved' : 'Save'),
      el('button', {class: 'btn', type: 'button', onclick: actions.share}, 'Share link'),
      el('button', {class: 'btn', type: 'button', onclick: actions.clear}, 'Clear')),
    el('section', {class: 'section'}, el('h3', {}, 'Terrain here'), terrainSlot),
    summarySlot,
    el('section', {class: 'section'}, el('h3', {}, features.length ? `Features here (${features.length})` : 'Features here'),
      features.length ? features.map(f => featureCard(f, ctx))
        : el('p', {class: 'empty-state small'}, 'No mapped features from the visible layers under this point. Turn on layers to see more; absence of a feature here says nothing about safety.')));
  const snowOn = ['snodas-depth', 'snodas-swe'].some(id => ctx.reg?.state.get(id)?.on);
  if (snowOn) {
    const slot = el('section', {class: 'section'}, el('h3', {}, 'SNODAS here (modeled, about 1 km)'), el('p', {class: 'muted small'}, 'Reading\u2026'));
    root.insertBefore(slot, summarySlot);
    sampleSnodas(place.lon, place.lat).then(v => slot.replaceChildren(slot.firstChild, v
      ? el('div', {}, kv([['Snow depth', v.depthMm === null ? 'no data' : fmtSnowDepth(v.depthMm / 10)], ['SWE', v.sweMm === null ? 'no data' : fmtWater(v.sweMm)]]),
        el('p', {class: 'small muted'}, `Analysis ${fmtDay(`${v.analysisDate}T12:00:00Z`)}. Whole snowpack in a 1 km cell, not this slope; not new snow.`))
      : el('p', {class: 'small muted'}, 'Outside the SNODAS Colorado grid.'))).catch(e => slot.replaceChildren(slot.firstChild, el('p', {class: 'small muted'}, `SNODAS unavailable (${e.message}).`)));
  }
  if (['pra', 'runout'].some(id => ctx.reg?.state.get(id)?.on)) {
    const slot = el('section', {class: 'section'}, el('h3', {}, 'Modeled avalanche terrain here'), el('p', {class: 'muted small'}, 'Reading\u2026'));
    root.insertBefore(slot, summarySlot);
    const STATE = {outside: 'outside the modeled pilot', nodata: 'no data', notReached: 'not reached by any modeled path'};
    inspectAvalanche(ctx, place.lon, place.lat).then(vals => slot.replaceChildren(slot.firstChild, !vals ? el('p', {class: 'small muted'}, 'Tap values not published yet.')
      : el('div', {}, el('p', {class: 'note exp small'}, 'Experimental terrain model. Not a hazard rating, not a probability, and says nothing about current conditions.'),
        kv(vals.map(v => [v.label, v.state !== 'value' ? STATE[v.state] : v.text ?? `${Number(v.value.toFixed(3))}${v.unit ? ` ${v.unit}` : ''}`]))))).catch(e =>
      slot.replaceChildren(slot.firstChild, el('p', {class: 'small muted'}, `Model values unavailable (${e.message}).`)));
  }
  inspectTerrain(place.lon, place.lat).then(t => {
    terrainSlot.replaceChildren(terrainBlock(t));
    if (t && !t.error && place.elevationM === undefined) place.elevationM = t.elevationM;
    ctx.conditions?.renderPlaceSummary?.(summarySlot, {...place, elevationM: t?.elevationM ?? null});
  });
  const acc = (ctx.officialLinks || []).find(l => l.id === 'caic-accidents-colorado');
  if (acc) root.append(el('p', {class: 'small muted'}, 'Accident history: ', link(acc.url, acc.title), ' (official records; not copied into this app).'));
  if (!ctx.conditions) summarySlot.append(el('p', {class: 'small muted'}, 'Forecast and weather summary: not available yet (conditions module not loaded).'));
  return root;
}
