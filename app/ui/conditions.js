// Conditions view: avalanche forecast first, then weather now and next 48 h, hourly and daily detail, then nearby
// SNOTEL. Each provider loads and fails on its own; a new show() cancels in-flight requests. All text goes through
// dom.js el() (text nodes), so upstream and imported strings are never parsed as HTML.

import {CONFIG} from '../config.js';
import {el, link} from './dom.js';
import {fmtElevation, fmtElevationDelta, fmtDistance, fmtTemp, fmtSpeed, fmtSnowDepth, fmtWater, fmtSnowfall, compass, finite, NA} from '../lib/units.js';
import {fmtDateTime, fmtDay, fmtHour, ageText, toMs, localDate, shiftDate, HOUR} from '../lib/time.js';
import {getNws, accumulate, range, valueAt} from '../providers/nws.js';
import {getOpenMeteo, currentHour, weatherLabel, OPEN_METEO} from '../providers/openmeteo.js';
import {getCaic, officialLink, DANGER_NAMES} from '../providers/caic.js';
import {loadStations, nearestStations, getLatest, getStationDetail, stationInfo} from '../providers/snotel.js';

const SVGNS = 'http://www.w3.org/2000/svg';
const caicEnabled = () => !!CONFIG.providers?.caic?.enabled;
const caicProductEnabled = () => CONFIG.providers?.caic?.product?.enabled === true;
const OFFICIAL_LABEL = 'Official CAIC forecast (opens avalanche.state.co.us)';
const LOADING = {state: 'loading'};

/* ---- Station list: static, loaded once per page (retried after a failure) ---- */
let stationsP = null;
function stationList() {
  if (!stationsP) stationsP = loadStations().then(r => { if (r.state !== 'ok') stationsP = null; return r; });
  return stationsP;
}

/* ---- Small shared pieces ---- */
const badge = (text, kind = 'warn') => el('span', {class: `badge ${kind}`}, text);
const fine = (...kids) => el('p', {class: 'cx-fine muted'}, ...kids);
const heading = text => el('h3', {class: 'cx-h'}, text);
const officialButton = (href, text) => el('a', {class: 'btn primary block cx-official', href, target: '_blank', rel: 'noopener noreferrer'}, text);
/** Notice for any provider object that is not plainly ok. */
function stateNote(v, what) {
  if (!v || v.state === 'loading') return el('p', {class: 'muted'}, `Loading ${what}...`);
  if (v.state === 'ok') return null;
  const label = {stale: 'Saved copy', expired: 'Expired', unavailable: 'Unavailable', 'outside-coverage': 'Outside coverage', error: 'Error'}[v.state] || v.state;
  return el('p', {class: 'note'}, badge(label), ' ', v.message || '');
}
const windText = (ms, deg) => (finite(ms) ? `${finite(deg) ? `${compass(deg)} ` : ''}${fmtSpeed(ms)}` : NA);
const rangeText = (a, b, f) => (finite(a) && finite(b) ? (f(a) === f(b) ? f(a) : `${f(a)} to ${f(b)}`) : NA);

/* ---- Avalanche forecast ---- */
const ZONE_TEXT = {'no-rating': 'No rating published', expired: 'Expired: not a current rating', 'not-yet-valid': 'Not yet in effect',
  'unknown-validity': 'Validity unknown: not shown'};
const dangerBadge = level => el('span', {class: `cx-danger d${level}`}, `${level} ${DANGER_NAMES[level]}`);

function zoneBlock(z, {route = false} = {}) {
  const head = z.display === 'rated' ? dangerBadge(z.dangerLevel) : badge(ZONE_TEXT[z.display] || z.display);
  return el('div', {class: 'cx-zone'},
    el('div', {class: 'cx-zone-head'}, head, z.display === 'rated' ? el('span', {class: 'muted'}, ' overall rating, this zone') : null),
    el('p', {class: 'cx-times'}, `Issued ${fmtDateTime(z.validFrom)}. ${z.validity === 'expired' ? 'Expired' : 'Expires'} ${fmtDateTime(z.validTo)}.`),
    z.display === 'rated' && z.travelAdvice ? el('p', {}, z.travelAdvice) : null,
    z.warning && z.validity === 'current' ? el('p', {class: 'note'}, 'An avalanche warning is in effect. Read the official product.') : null,
    route && z.officialUrl ? link(z.officialUrl, 'This zone on CAIC') : null);
}

const BANDS = [['upper', 'Above treeline'], ['middle', 'Near treeline'], ['lower', 'Below treeline']];
function productBlock(p) {
  if (!p) return null;
  if (p.state === 'mismatch') return fine('The detailed product did not match this zone and publication, so it is not shown.');
  if (p.state === 'expired') return fine('The detailed product has expired, so it is not shown.');
  if (p.state !== 'ok') return fine(`Detailed product unavailable${p.message ? ` (${p.message})` : ''}.`);
  // "current" is the Colorado date of expires_time, "tomorrow" the day after (docs/sources/conditions.md 2.1.3).
  const days = p.danger.filter(d => d.day === 'current' || d.day === 'tomorrow'), d0 = localDate(toMs(p.expiresAt));
  const cell = v => (v ? dangerBadge(v) : el('span', {class: 'muted'}, NA));
  const table = el('table', {class: 'cx-table'}, el('thead', {}, el('tr', {}, el('th', {}, 'Elevation band'), days.map(d => el('th', {}, fmtDay(d.day === 'current' ? d0 : shiftDate(d0, 1)))))),
    el('tbody', {}, BANDS.map(([k, label]) => el('tr', {}, el('th', {scope: 'row'}, label), days.map(d => el('td', {}, cell(d[k])))))));
  const problems = p.problems.length ? el('ul', {class: 'cx-list'}, p.problems.map(x => el('li', {},
    el('strong', {}, x.name), `: ${x.likelihood || 'likelihood n/a'}, size ${x.size.length ? x.size.map(n => `D${n}`).join(' to ') : NA}`,
    x.locations.length ? el('div', {class: 'muted'}, `Where: ${x.locations.join(', ')}`) : null))) : el('p', {class: 'muted'}, 'No avalanche problems listed.');
  return el('div', {class: 'cx-product'}, table, el('h4', {}, 'Avalanche problems'), problems,
    p.bottomLine ? [el('h4', {}, 'Bottom line (CAIC)'), el('p', {class: 'cx-pre'}, p.bottomLine)] : null,
    fine(`CAIC forecast ${p.author ? `by ${p.author}, ` : ''}published ${fmtDateTime(p.publishedAt)}. Forecast area includes: ${p.areaNames.join(', ') || NA}.`));
}

function avyBody(c) {
  if (c.state === 'loading') return [el('p', {class: 'muted'}, 'Loading the CAIC forecast feed...')];
  if (c.state === 'disabled') return [el('p', {}, 'No danger rating is shown in this app: the CAIC forecast feed is switched off until permission to reuse it is confirmed. The button above opens the official forecast for this location.')];
  if (c.state === 'unavailable' || c.state === 'no-product') return [el('p', {class: 'note'}, badge(c.state === 'unavailable' ? 'Unavailable' : 'No product'), ' ', c.message)];
  const out = [c.cached ? el('p', {class: 'note'}, badge('Saved copy'), ' ', c.message) : null];
  if (c.state === 'outside-coverage') out.push(el('p', {}, badge('Outside coverage'), ' This point is outside every CAIC forecast zone in the current feed. No rating is inferred.'));
  else if (c.state === 'boundary-overlap') out.push(el('p', {}, badge('Zone boundary'), ' This point is where forecast zones overlap, so no single rating is given. Each zone:'), c.point.zones.map(z => zoneBlock(z)));
  else out.push(zoneBlock(c.point.zones[0]), productBlock(c.product));
  if (c.route) {
    out.push(el('h4', {}, `Along this route: ${c.route.zones.length} forecast zone${c.route.zones.length === 1 ? '' : 's'}`), c.route.zones.map(z => zoneBlock(z, {route: true})));
    if (c.route.outside) out.push(fine(`${c.route.outside} of ${c.route.samples} points checked along the route are outside every zone.`));
    if (c.route.overlap) out.push(fine(`${c.route.overlap} points checked are on zone overlaps.`));
  }
  return out;
}

/** Start, high point (when the line carries elevations) and end of a route, for official links. */
function routeLinkPoints(line) {
  const c = line?.type === 'LineString' && Array.isArray(line.coordinates) ? line.coordinates.filter(p => finite(p?.[0]) && finite(p?.[1])) : [];
  if (c.length < 2) return [];
  const withZ = c.filter(p => finite(p[2]));
  const high = withZ.length ? withZ.reduce((a, b) => (b[2] > a[2] ? b : a)) : null;
  return [['Start', c[0]], high ? ['High point', high] : null, ['End', c.at(-1)]].filter(Boolean);
}
function renderAvalanche(s) {
  const c = s.caic || (caicEnabled() ? LOADING : {state: 'disabled'});
  const routePts = c.route ? [] : routeLinkPoints(s.place.line);
  return [heading('Avalanche forecast'), officialButton(officialLink(s.place), OFFICIAL_LABEL),
    routePts.length ? el('p', {class: 'cx-route-links'}, 'Along the route: ', routePts.map(([label, p], i) => [i ? ', ' : '', link(officialLink({lon: p[0], lat: p[1]}), label)])) : null,
    ...avyBody(c),
    fine('CAIC is the official source; its forecast map opens the forecast area containing this point. This app never derives a danger rating from weather, snow or terrain. A missing, failed or expired forecast is not low danger.')];
}

/* ---- Weather now and next 48 h ---- */
function elevationContext(s) {
  const p = s.place, n = s.nws, o = s.om, parts = [];
  parts.push(`Selected point: ${finite(p.elevationM) ? fmtElevation(p.elevationM) : 'elevation not known'}.`);
  if (finite(n?.grid?.elevationM)) parts.push(`NWS forecast grid cell (about 2.5 km): ${fmtElevation(n.grid.elevationM)}${finite(p.elevationM) ? ` (${fmtElevationDelta(n.grid.elevationM - p.elevationM)} vs the point)` : ''}.`);
  if (o?.grid) parts.push(`Open-Meteo model cell centred ${fmtDistance(o.grid.distanceM)} away; its temperature is adjusted to ${fmtElevation(o.grid.temperatureElevationM)} (${o.grid.temperatureElevationSource}).`);
  parts.push('Values are for a forecast grid, not a ridge or a specific slope.');
  return fine(parts.join(' '));
}

function nowBlock(s, now) {
  const h = s.om?.hours ? currentHour(s.om, now) : null, ser = s.nws?.series;
  const model = h ? [['Temperature', fmtTemp(h.tempC)], ['Wind', windText(h.windMs, h.windDirDeg)], ['Gusts', fmtSpeed(h.gustMs)],
    ['Sky', `${weatherLabel(h.code) || NA}, cloud ${finite(h.cloudPct) ? `${Math.round(h.cloudPct)}%` : NA}`], ['Freezing level', fmtElevation(h.freezingM)]] : null;
  const nws = ser ? [['Temperature', fmtTemp(valueAt(ser.temperature, now))], ['Wind', windText(valueAt(ser.windSpeed, now), valueAt(ser.windDirection, now))],
    ['Gusts', fmtSpeed(valueAt(ser.windGust, now))], ['Sky cover', finite(valueAt(ser.skyCover, now)) ? `${Math.round(valueAt(ser.skyCover, now))}%` : NA]] : null;
  const box = (title, rows, v, what) => el('div', {class: 'cx-now'}, el('h4', {}, title), rows ? el('dl', {class: 'kv'}, rows.map(([k, x]) => [el('dt', {}, k), el('dd', {}, x)])) : null,
    rows ? null : v?.state === 'ok' ? el('p', {class: 'muted'}, 'Not in this response.') : stateNote(v || LOADING, what));
  return el('div', {class: 'cx-now-grid'}, box('Model now (Open-Meteo)', model, s.om, 'the model forecast'), box('NWS forecast now', nws, s.nws, 'the NWS forecast'));
}

function nextTable(s, now) {
  const o = s.om, ser = s.nws?.series, t0 = Math.floor(now / HOUR) * HOUR;
  const w = hrs => ({snow: ser ? accumulate(ser.snowfall, t0, t0 + hrs * HOUR) : null, qpf: ser ? accumulate(ser.qpf, t0, t0 + hrs * HOUR) : null,
    lvl: ser ? range(ser.snowLevel, t0, t0 + hrs * HOUR) : {min: null, max: null}});
  const n24 = w(24), n48 = w(48), a = o?.next24, b = o?.next48;
  const rows = [['Snowfall, model (Open-Meteo)', fmtSnowfall(a?.snowCm), fmtSnowfall(b?.snowCm)], ['Snowfall, NWS forecast', fmtSnowfall(n24.snow), fmtSnowfall(n48.snow)],
    ['Precipitation (water), model', fmtWater(a?.precipMm), fmtWater(b?.precipMm)], ['Precipitation (water), NWS', fmtWater(n24.qpf), fmtWater(n48.qpf)],
    ['Low to high, model', rangeText(a?.tMinC, a?.tMaxC, fmtTemp), rangeText(b?.tMinC, b?.tMaxC, fmtTemp)], ['Strongest gust, model', fmtSpeed(a?.gustMaxMs), fmtSpeed(b?.gustMaxMs)],
    ['Freezing level, model', rangeText(a?.freezingMinM, a?.freezingMaxM, fmtElevation), rangeText(b?.freezingMinM, b?.freezingMaxM, fmtElevation)],
    ['Snow level, NWS', rangeText(n24.lvl.min, n24.lvl.max, fmtElevation), rangeText(n48.lvl.min, n48.lvl.max, fmtElevation)]];
  return el('table', {class: 'cx-table cx-next'}, el('thead', {}, el('tr', {}, el('th', {}, ''), el('th', {}, 'Next 24 h'), el('th', {}, 'Next 48 h'))),
    el('tbody', {}, rows.map(([k, x, y]) => el('tr', {}, el('th', {scope: 'row'}, k), el('td', {}, x), el('td', {}, y)))));
}

function alertsBlock(n) {
  const a = n?.alerts;
  if (!a) return null;
  if (a.state !== 'ok') return el('p', {class: 'note'}, badge('Alerts unavailable'), ` NWS alerts could not be checked${a.message ? ` (${a.message})` : ''}. No alert is not the same as unchecked.`);
  if (!a.items.length) return fine(`No active NWS watches, warnings or advisories for this point (checked ${fmtDateTime(a.retrievedAt)}).`);
  return el('div', {}, a.items.map(x => el('div', {class: 'note cx-alert'}, el('strong', {}, x.event), x.headline ? el('div', {}, x.headline) : null,
    el('div', {class: 'muted'}, `${x.severity ? `${x.severity}. ` : ''}Until ${fmtDateTime(x.ends || x.expires)}`))));
}

function renderWeather(s, now) {
  const n = s.nws, o = s.om;
  const times = [];
  if (n?.issuedAt) times.push(`NWS updated ${fmtDateTime(n.issuedAt)} (${n.office} grid ${n.gridX},${n.gridY}).`);
  if (o?.retrievedAt) times.push(`Model retrieved ${fmtDateTime(o.retrievedAt)}; ${o.modelLabel}.`);
  return [heading('Weather now and next 48 hours'), elevationContext(s), alertsBlock(n), nowBlock(s, now),
    n?.series ? stateNote(n, 'the NWS forecast') : null, o?.hours ? stateNote(o, 'the model forecast') : null, nextTable(s, now),
    fine('NWS snowfall comes in 6 h blocks; a block cut by the window is split evenly by hour. Model snowfall uses Open-Meteo\'s fixed snow-to-water ratio. Forecast snowfall is not measured snow and says nothing about snowpack stability.'),
    fine(...times, ' ', n?.sourceUrl ? link(n.sourceUrl, 'NWS point forecast') : null, '. ', link(OPEN_METEO.attributionUrl, OPEN_METEO.attribution), ` (${OPEN_METEO.license}).`)];
}

/* ---- Hourly and daily detail ---- */
const PTYPE = {snow: 'snow', rain: 'rain', mixed: 'rain and snow', 'freezing rain': 'freezing rain', thunderstorm: 'thunderstorm'};
function hourRow(h) {
  const type = PTYPE[h.ptype];
  const precip = type ? `${type}${h.ptype === 'snow' || h.ptype === 'mixed' ? ` ${fmtSnowfall(h.snowCm)}` : ` ${fmtWater(h.precipMm)}`}` : h.ptype === 'none' ? 'dry' : NA;
  return el('li', {class: 'cx-row'}, el('span', {class: 'cx-t'}, fmtHour(h.time)), el('span', {class: 'cx-v'}, fmtTemp(h.tempC)),
    el('span', {class: 'cx-v'}, `${windText(h.windMs, h.windDirDeg)}, gust ${fmtSpeed(h.gustMs, {bare: true})}`), el('span', {class: 'cx-v'}, precip),
    el('span', {class: 'cx-sub muted'}, `${weatherLabel(h.code) || NA}, cloud ${finite(h.cloudPct) ? `${Math.round(h.cloudPct)}%` : NA}, freezing level ${fmtElevation(h.freezingM)}`));
}
function renderHourly(s, now) {
  const o = s.om;
  if (!o?.hours) return stateNote(o || LOADING, 'the model forecast');
  const t0 = Math.floor(now / HOUR) * HOUR, hours = o.hours.filter(h => { const t = toMs(h.time); return t >= t0 && t < t0 + 48 * HOUR; });
  const groups = [];
  for (const h of hours) { const d = localDate(toMs(h.time)); if (!groups.length || groups.at(-1).d !== d) groups.push({d, hs: []}); groups.at(-1).hs.push(h); }
  return [stateNote(o, 'the model forecast'), groups.map(g => [el('h4', {class: 'cx-day'}, fmtDay(g.d)), el('ul', {class: 'cx-rows'}, g.hs.map(hourRow))]),
    fine('Open-Meteo model, hourly, Colorado time. Temperature, wind and freezing level are at the hour; gusts, precipitation and snowfall are for the hour ending then.')];
}
function dayRow(d, i) {
  return el('li', {class: `cx-row cx-dayrow${i >= 3 ? ' cx-far' : ''}`}, el('span', {class: 'cx-t'}, fmtDay(d.date)),
    el('span', {class: 'cx-v'}, `${fmtTemp(d.tMaxC)} / ${fmtTemp(d.tMinC)}`), el('span', {class: 'cx-v'}, `snow ${fmtSnowfall(d.snowCm)}`),
    el('span', {class: 'cx-v'}, `water ${fmtWater(d.precipMm)}`),
    el('span', {class: 'cx-sub muted'}, `${i >= 3 ? 'Lower confidence. ' : ''}Strongest gust ${fmtSpeed(d.gustMaxMs)}, freezing level ${rangeText(d.freezingMinM, d.freezingMaxM, fmtElevation)}`));
}
function renderDaily(s) {
  const o = s.om, n = s.nws;
  const periods = (n?.periods || []).slice(0, 8).map(p => el('li', {class: 'cx-period'}, el('strong', {}, p.name), ` ${p.shortForecast}`, el('div', {class: 'muted'}, p.detailedForecast)));
  return [o?.days ? el('ul', {class: 'cx-rows'}, o.days.map(dayRow)) : stateNote(o || LOADING, 'the model forecast'),
    fine('Model days are Colorado calendar days (high / low, snowfall, water). Days 4 to 7 are less reliable; treat them as a trend.'),
    el('h4', {}, 'NWS forecast text'), periods.length ? el('ul', {class: 'cx-list'}, periods)
      : n?.parts?.forecast === 'unavailable' ? el('p', {class: 'muted'}, 'NWS forecast text unavailable in this response.') : stateNote(n || LOADING, 'the NWS forecast'),
    periods.length ? fine('NWS text is the official forecast wording and uses US units.') : null];
}

/* ---- SNOTEL ---- */
function chart(points, {label, fmt}) {
  const pts = points.filter(p => finite(p.v));
  if (pts.length < 2) return el('p', {class: 'muted'}, `${label}: not enough usable readings to plot.`);
  const W = 320, H = 110, L = 4, R = 4, T = 16, B = 18, t0 = points[0].t, t1 = points.at(-1).t;
  const lo = Math.min(...pts.map(p => p.v)), hi = Math.max(...pts.map(p => p.v)), pad = hi - lo < 1e-9 ? 1 : 0; // flat line: centre it
  const x = t => L + (t - t0) / (t1 - t0 || 1) * (W - L - R), y = v => T + (hi + pad - v) / (hi - lo + 2 * pad) * (H - T - B);
  const svg = document.createElementNS(SVGNS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`); svg.setAttribute('class', 'cx-chart'); svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', `${label}, ${fmt(pts[0].v)} to ${fmt(pts.at(-1).v)}; range ${fmt(lo)} to ${fmt(hi)}`);
  const add = (tag, attrs, text) => { const n = document.createElementNS(SVGNS, tag); for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v); if (text) n.textContent = text; svg.append(n); };
  let seg = [];
  const flush = () => { if (seg.length > 1) add('polyline', {points: seg.join(' '), class: 'cx-line'}); if (seg.length === 1) add('circle', {cx: seg[0].split(',')[0], cy: seg[0].split(',')[1], r: 2, class: 'cx-dot'}); seg = []; };
  for (const p of points) { if (finite(p.v)) seg.push(`${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`); else flush(); }
  flush();
  add('text', {x: L, y: 11, class: 'cx-ax'}, `max ${fmt(hi)}`);
  add('text', {x: W - R, y: 11, class: 'cx-ax', 'text-anchor': 'end'}, `min ${fmt(lo)}`);
  add('text', {x: L, y: H - 4, class: 'cx-ax'}, fmtDay(new Date(t0).toISOString()));
  add('text', {x: W - R, y: H - 4, class: 'cx-ax', 'text-anchor': 'end'}, fmtDay(new Date(t1).toISOString()));
  return el('figure', {class: 'cx-fig'}, el('figcaption', {}, label), svg);
}
const plot = series => (series || []).map(r => ({t: toMs(r.observedAt), v: r.usable ? r.value : null}));

function latestText(r, f) {
  if (!r) return NA;
  if (!r.usable) return `${r.quality} reading (not used)`;
  return `${f(r.value)}${r.quality === 'estimated' ? ' (estimated)' : ''}${r.delayed ? ', delayed' : ''}`;
}
function changesTable(sum) {
  const rows = [['Snow depth', 'SNWD', fmtSnowDepth], ['Snow water (SWE)', 'WTEQ', fmtWater], ['Precipitation', 'PREC', fmtWater]];
  const notes = [];
  const cell = (c, f, name, w) => { if (finite(c?.delta)) return f(c.delta, {signed: true}); if (c?.reason) notes.push(`${name} ${w}: ${c.reason}.`); return NA; };
  const t = el('table', {class: 'cx-table'}, el('thead', {}, el('tr', {}, el('th', {}, 'Change'), el('th', {}, '24 h'), el('th', {}, '7 days'), el('th', {}, '30 days'))),
    el('tbody', {}, rows.map(([name, k, f]) => el('tr', {}, el('th', {scope: 'row'}, name), el('td', {}, cell(sum[k]?.change24h, f, name, '24 h')),
      el('td', {}, cell(sum[k]?.change7d, f, name, '7 days')), el('td', {}, cell(sum[k]?.change30d, f, name, '30 days'))))));
  return [t, notes.length ? fine(notes.join(' ')) : null];
}
function stationDetail(d) {
  if (!d || d.state === 'loading') return el('p', {class: 'muted'}, 'Loading station history (NRCS can take up to 30 s)...');
  if (!d.summary) return stateNote(d, 'station data');
  const s = d.summary, c24 = s.SNWD.change24h, c30 = s.SNWD.change30d;
  const bad = Object.values(d.hourly || {}).flat().filter(r => !r.usable).length;
  return el('div', {class: 'cx-station'}, stateNote(d, 'station data'),
    el('p', {}, el('strong', {}, `${d.name} (${d.triplet})`), `, ${fmtElevation(d.elevationM)}. `, link(d.sourceUrl, 'NRCS station page')),
    el('dl', {class: 'kv'}, [['Snow depth', latestText(s.SNWD.latest, fmtSnowDepth)], ['Snow water (SWE)', latestText(s.WTEQ.latest, fmtWater)],
      ['Air temperature', latestText(s.TOBS.latest, fmtTemp)], ['Observed', fmtDateTime(s.SNWD.latest?.observedAt || s.TOBS.latest?.observedAt)]]
      .map(([k, v]) => [el('dt', {}, k), el('dd', {}, v)])),
    changesTable(s),
    fine(`24 h and 7 day changes use hourly readings ending ${fmtDateTime(c24.to)}; 30 day changes use end-of-day readings ending ${fmtDateTime(c30.to)}. A depth change is not new snowfall: settling, wind and melt change depth too. Precipitation is the gauge total since Oct 1, which undercatches snow.`),
    chart(plot(d.hourly.SNWD), {label: 'Snow depth, hourly, 7 days', fmt: fmtSnowDepth}),
    chart(plot(d.daily.WTEQ), {label: 'Snow water (SWE), end of day, 30 days', fmt: fmtWater}),
    chart(plot(d.hourly.TOBS), {label: 'Air temperature, hourly, 7 days', fmt: fmtTemp}),
    fine(`${bad ? `${bad} hourly readings in this period are suspect, missing or implausible; they are gaps in the charts and are never counted as zero. ` : ''}Station clock: UTC${d.dataTimeZone} all year (${d.timeZoneSource}); shown here in Colorado time. NRCS notes a known bias in SNOTEL air temperature. Retrieved ${fmtDateTime(d.retrievedAt)}.`));
}

function stationRow(st, s, view) {
  const l = s.latest?.byTriplet?.[st.triplet], open = s.openTriplet === st.triplet;
  const depth = !s.latest ? 'loading' : s.latest.state !== 'ok' ? 'readings unavailable' : l?.depth ? `depth ${latestText(l.depth, fmtSnowDepth)}, ${ageText(l.depth.observedAt, view.now())}` : 'no recent depth reading';
  const elev = finite(st.elevationDiffM) ? `${fmtElevationDelta(st.elevationDiffM)} vs point` : finite(st.elevationM) ? fmtElevation(st.elevationM) : 'elevation n/a';
  return el('li', {class: 'cx-st'}, el('button', {type: 'button', class: 'cx-st-btn', 'aria-expanded': String(open), onclick: () => view.toggleStation(st)},
    el('span', {class: 'cx-st-name'}, st.name), el('span', {class: 'muted'}, `${fmtDistance(st.distanceM)} away, ${elev}`), el('span', {}, depth)),
  open ? stationDetail(s.detail) : null);
}
function renderSnotel(s, view) {
  const list = s.stations, near = list?.state === 'ok' ? list.near : [], x = s.extraStation;
  const all = x && !near.some(n => n.triplet === x.triplet) ? [x, ...near] : near;
  const head = heading('Nearby SNOTEL stations (measured)');
  const status = !list ? el('p', {class: 'muted'}, 'Loading the station list...') : list.state !== 'ok' ? stateNote(list, 'stations')
    : !near.length ? el('p', {}, 'No SNOTEL station within 60 km of this point.') : null;
  if (!all.length) return [head, status];
  return [head, status, s.latest && s.latest.state !== 'ok' ? stateNote(s.latest, 'readings') : null,
    el('ul', {class: 'cx-stations'}, all.map(st => stationRow(st, s, view))),
    fine('Stations measure at their own site and elevation. The nearest station is not necessarily representative of alpine, wind-loaded or different-aspect terrain.')];
}

/* ---- View ---- */
/** Mount the conditions view in container. Returns {show(place), showStation(stationFeature), clear()}. */
export function createConditionsView(container) {
  const root = el('div', {class: 'cx'});
  const sec = {avy: el('section', {class: 'card cx-avy', 'aria-live': 'polite'}), wx: el('section', {class: 'card'}),
    hourlyBody: el('div', {}), dailyBody: el('div', {}), snotel: el('section', {class: 'card'})};
  const hourly = el('details', {class: 'card cx-details'}, el('summary', {}, 'Hourly, next 48 hours'), sec.hourlyBody);
  const daily = el('details', {class: 'card cx-details'}, el('summary', {}, 'Daily, 7 days, and NWS forecast text'), sec.dailyBody);
  const head = el('div', {class: 'cx-head'});
  root.append(head, sec.avy, sec.wx, hourly, daily, sec.snotel);
  container.append(root);
  let s = null, ctrl = null, stCtrl = null, seq = 0;

  const view = {now: () => Date.now(), toggleStation};
  function renderHead() {
    const p = s.place;
    head.replaceChildren(el('p', {class: 'cx-place'}, el('strong', {}, p.name || 'Selected point'), ` ${p.lat.toFixed(4)}, ${p.lon.toFixed(4)}`,
      finite(p.elevationM) ? `, ${fmtElevation(p.elevationM)}` : ''), el('button', {type: 'button', class: 'btn', onclick: () => api.show(s.place, {openTriplet: s.openTriplet, extraStation: s.extraStation})}, 'Refresh'));
  }
  function render(which = ['head', 'avy', 'wx', 'hourly', 'daily', 'snotel']) {
    if (!s) return;
    const now = Date.now();
    if (which.includes('head')) renderHead();
    if (which.includes('avy')) sec.avy.replaceChildren(...renderAvalanche(s).flat().filter(Boolean));
    if (which.includes('wx')) sec.wx.replaceChildren(...renderWeather(s, now).flat().filter(Boolean));
    if (which.includes('hourly')) sec.hourlyBody.replaceChildren(...[renderHourly(s, now)].flat(3).filter(Boolean));
    if (which.includes('daily')) sec.dailyBody.replaceChildren(...renderDaily(s).flat().filter(Boolean));
    if (which.includes('snotel')) sec.snotel.replaceChildren(...renderSnotel(s, view).flat().filter(Boolean));
  }
  const set = (token, key, parts) => v => { if (token !== seq || v?.state === 'aborted') return; s[key] = v; render(parts); };

  async function toggleStation(st) {
    stCtrl?.abort();
    if (s.openTriplet === st.triplet) { s.openTriplet = null; s.detail = null; render(['snotel']); return; }
    stCtrl = new AbortController();
    const token = seq;
    s.openTriplet = st.triplet; s.detail = LOADING; render(['snotel']);
    set(token, 'detail', ['snotel'])(await getStationDetail(st, {signal: stCtrl.signal}));
  }
  function loadSnotel(token, signal, openTriplet) {
    stationList().then(list => {
      if (token !== seq) return;
      const near = list.state === 'ok' ? nearestStations(s.place, list.features) : [];
      set(token, 'stations', ['snotel'])({...list, near});
      const x = s.extraStation, ask = x && !near.some(n => n.triplet === x.triplet) ? [x, ...near] : near;
      if (ask.length) getLatest(ask, {signal}).then(set(token, 'latest', ['snotel']));
      const open = openTriplet && (near.find(x => x.triplet === openTriplet) || s.extraStation);
      if (open) toggleStation(open);
    });
  }
  const onUnits = () => { if (!container.isConnected) { window.removeEventListener('skintrack:units', onUnits); return; } render(); };
  window.addEventListener('skintrack:units', onUnits);

  const api = {
    /** Show conditions for place {lon, lat, name?, elevationM?, line?}. Cancels anything still loading. */
    show(place, {openTriplet = null, extraStation = null} = {}) {
      if (!place || !finite(place.lon) || !finite(place.lat)) return;
      ctrl?.abort(); stCtrl?.abort();
      ctrl = new AbortController();
      const token = ++seq, signal = ctrl.signal;
      s = {place, caic: null, nws: null, om: null, stations: null, latest: null, detail: null, openTriplet: null, extraStation};
      render();
      if (caicEnabled()) getCaic(place, {enabled: true, detail: caicProductEnabled(), signal}).then(set(token, 'caic', ['avy']));
      getNws(place, {signal}).then(set(token, 'nws', ['wx', 'daily']));
      getOpenMeteo(place, {signal}).then(set(token, 'om', ['wx', 'hourly', 'daily']));
      loadSnotel(token, signal, openTriplet);
    },
    /** Show conditions at a SNOTEL station (a GeoJSON feature from the station list) with its detail open. */
    showStation(feature) {
      const st = stationInfo(feature);
      if (!finite(st.lon) || !finite(st.lat)) return;
      api.show({lon: st.lon, lat: st.lat, name: `${st.name} SNOTEL`, elevationM: st.elevationM},
        {openTriplet: st.triplet, extraStation: {...st, distanceM: 0, elevationDiffM: 0}});
    },
    /** Cancel loading and empty the view. */
    clear() { ctrl?.abort(); stCtrl?.abort(); seq++; s = null; head.replaceChildren(); for (const k of ['avy', 'wx', 'hourlyBody', 'dailyBody', 'snotel']) sec[k].replaceChildren(); }
  };
  return api;
}

/* ---- One-line summary for the map's place card ---- */
const summaries = new WeakMap();
function summaryText(d, place) {
  const c = d.caic, h = d.om?.hours ? currentHour(d.om, Date.now()) : null, st = d.station, l = d.latest?.byTriplet?.[st?.triplet]?.depth;
  const avy = !c ? 'Avalanche: loading' : c.state === 'disabled' ? null : c.state === 'rated' ? `CAIC ${c.point.zones[0].dangerLevel} ${DANGER_NAMES[c.point.zones[0].dangerLevel]}`
    : `CAIC: ${ZONE_TEXT[c.state] || c.state.replace(/-/g, ' ')}`;
  const wx = !d.om ? 'Weather: loading' : h ? `${fmtTemp(h.tempC)}, wind ${windText(h.windMs, h.windDirDeg)} (model)` : 'Weather unavailable';
  const sn = !d.stations ? 'SNOTEL: loading' : !st ? null : !d.latest ? `${st.name}: loading` : l?.usable ? `${st.name} SNOTEL depth ${fmtSnowDepth(l.value)} (${fmtDistance(st.distanceM)} away)` : `${st.name} SNOTEL: no current depth`;
  return {avy, wx, sn, official: officialLink(place)};
}
function paintSummary(target) {
  const d = summaries.get(target);
  if (!d) return;
  const t = summaryText(d, d.place);
  target.replaceChildren(el('p', {class: 'cx-summary'},
    t.avy ? el('span', {}, t.avy) : el('a', {href: t.official, target: '_blank', rel: 'noopener noreferrer'}, 'CAIC forecast'),
    el('span', {}, t.wx), t.sn ? el('span', {}, t.sn) : null));
}

/** Compact one-line conditions summary (forecast state, temperature and wind, nearest station depth) into target. */
export function renderPlaceSummary(target, place) {
  if (!target || !place || !finite(place.lon) || !finite(place.lat)) return;
  summaries.get(target)?.ctrl.abort();
  const ctrl = new AbortController(), signal = ctrl.signal;
  const d = {place, ctrl, caic: caicEnabled() ? null : {state: 'disabled'}, om: null, stations: null, station: null, latest: null};
  summaries.set(target, d);
  const set = key => v => { if (summaries.get(target) !== d || v?.state === 'aborted') return; d[key] = v; paintSummary(target); };
  paintSummary(target);
  if (caicEnabled()) getCaic(place, {enabled: true, detail: false, signal}).then(set('caic'));
  getOpenMeteo(place, {signal}).then(set('om'));
  stationList().then(list => {
    const near = list.state === 'ok' ? nearestStations(place, list.features, {n: 1}) : [];
    d.station = near[0] || null;
    set('stations')(list);
    if (d.station) getLatest(near, {signal}).then(set('latest'));
  });
  if (!target.dataset.cxUnits) {
    target.dataset.cxUnits = '1';
    const onUnits = () => { if (!target.isConnected) { window.removeEventListener('skintrack:units', onUnits); return; } paintSummary(target); };
    window.addEventListener('skintrack:units', onUnits);
  }
}
