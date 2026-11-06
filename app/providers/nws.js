// NOAA National Weather Service adapter (api.weather.gov). Calls /points/{lat},{lon} and then follows the
// forecast and forecastGridData URLs that response returns (grid ids are never built here), plus
// /alerts/active?point=. forecastHourly is not fetched: it repeats the same NDFD grid as forecastGridData in US
// units with text wind speeds, at about 160 KB per place. Output is SI; the grid cell's own elevation is kept
// so the page can compare it with the selected point, and is never presented as ridge-top weather.

import {CONFIG} from '../config.js';
import {request, withLastGood, placeKey} from './fetch.js';
import {toMs, iso, validityState, ageText, HOUR} from '../lib/time.js';
import {finite, fToC, mphToMs} from '../lib/units.js';

export const NWS = Object.freeze({
  api: CONFIG.providers.nws.api,
  /** Human forecast page for a point (official NWS product page). */
  page: (lat, lon) => `${CONFIG.providers.nws.page}?lat=${lat.toFixed(4)}&lon=${lon.toFixed(4)}`,
  staleAfterMs: 12 * HOUR, // forecast not updated for this long is flagged stale (NWS updates several times a day)
  keepMs: 24 * HOUR // oldest saved copy shown when a request fails
});
const HEADERS = {Accept: 'application/geo+json'};

/** ISO 8601 duration such as PT6H or P1DT3H to ms, or null. */
export function durationMs(d) {
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?)?$/.exec(String(d || ''));
  if (!m || !(m[1] || m[2] || m[3])) return null;
  return ((Number(m[1] || 0) * 24 + Number(m[2] || 0)) * 60 + Number(m[3] || 0)) * 60000;
}
/** NWS 'start/duration' validTime to [startMs, endMs), or null. */
export function interval(validTime) {
  const [s, d] = String(validTime || '').split('/');
  const a = toMs(s), len = durationMs(d);
  return a === null || !len ? null : [a, a + len];
}

const UNIT = {'wmoUnit:degC': 1, 'wmoUnit:km_h-1': 1 / 3.6, 'wmoUnit:m': 1, 'wmoUnit:mm': 1, 'wmoUnit:percent': 1, 'wmoUnit:degree_(angle)': 1};
/** A grid layer as [{from, to, v}] in SI (km/h becomes m/s); times are epoch ms. Unknown units throw. */
export function gridSeries(layer, scale = 1) {
  if (!layer || !Array.isArray(layer.values)) return [];
  const f = UNIT[layer.uom];
  if (!f) throw new Error(`Unexpected NWS unit ${layer.uom}`);
  return layer.values.map(x => {
    const iv = interval(x.validTime);
    return iv && {from: iv[0], to: iv[1], v: finite(x.value) ? x.value * f * scale : null};
  }).filter(Boolean).sort((a, b) => a.from - b.from);
}
/** Value of an interval series at instant t, or null. */
export const valueAt = (series, t) => series?.find(x => x.from <= t && t < x.to)?.v ?? null;
/**
 * Total of an accumulation series over [start, end), apportioned uniformly within partly covered intervals.
 * Null unless every moment of the window is covered by a finite value (missing is never zero).
 */
export function accumulate(series, start, end) {
  let total = 0, covered = 0;
  for (const x of series || []) {
    const o = Math.min(end, x.to) - Math.max(start, x.from);
    if (o <= 0) continue;
    if (!finite(x.v)) return null;
    total += x.v * o / (x.to - x.from);
    covered += o;
  }
  return covered >= end - start - 1 ? total : null;
}
/** Min and max of an interval series over [start, end); null when any part is missing. */
export function range(series, start, end) {
  const xs = (series || []).filter(x => x.to > start && x.from < end);
  const covered = xs.reduce((s, x) => s + Math.min(end, x.to) - Math.max(start, x.from), 0);
  if (!xs.length || covered < end - start - 1 || !xs.every(x => finite(x.v))) return {min: null, max: null};
  return {min: Math.min(...xs.map(x => x.v)), max: Math.max(...xs.map(x => x.v))};
}

/** '5 to 10 mph' or '7 mph' to [minMs, maxMs]. */
function windRange(s) {
  const m = /(\d+)(?:\s*to\s*(\d+))?\s*mph/i.exec(String(s || ''));
  return m ? [mphToMs(Number(m[1])), mphToMs(Number(m[2] || m[1]))] : [null, null];
}
function normalizePeriods(fp) {
  return (fp?.periods || []).map(p => {
    const t = finite(p.temperature) ? (p.temperatureUnit === 'C' ? p.temperature : fToC(p.temperature)) : null;
    const [wMin, wMax] = windRange(p.windSpeed);
    return {name: String(p.name || ''), startTime: p.startTime, endTime: p.endTime, isDaytime: !!p.isDaytime, tempC: t,
      windMinMs: wMin, windMaxMs: wMax, windDirection: String(p.windDirection || ''), popPct: finite(p.probabilityOfPrecipitation?.value) ? p.probabilityOfPrecipitation.value : null,
      shortForecast: String(p.shortForecast || ''), detailedForecast: String(p.detailedForecast || '')};
  }).filter(p => toMs(p.startTime) !== null);
}
function normalizeGrid(gp) {
  const g = k => gridSeries(gp?.[k]);
  return {temperature: g('temperature'), windSpeed: g('windSpeed'), windGust: g('windGust'), windDirection: g('windDirection'),
    skyCover: g('skyCover'), pop: g('probabilityOfPrecipitation'), snowLevel: g('snowLevel'), qpf: g('quantitativePrecipitation'),
    snowfall: gridSeries(gp?.snowfallAmount, 0.1)}; // NWS snowfallAmount is mm of snow; stored as cm
}
function normalizeAlerts(a) {
  return (a?.features || []).map(f => f.properties || {}).map(p => ({id: String(p.id || ''), event: String(p.event || 'Alert'),
    severity: String(p.severity || ''), headline: String(p.headline || ''), areaDesc: String(p.areaDesc || ''), instruction: String(p.instruction || ''),
    sent: p.sent || null, effective: p.effective || null, onset: p.onset || null, expires: p.expires || null, ends: p.ends || null}));
}

/** Pure: combine the raw responses into the normalized NWS object. */
export function normalizeNws({points, forecast, grid}, {lon, lat, elevationM = null, retrievedAt}) {
  const pp = points?.properties;
  if (!pp?.forecast || !pp?.forecastGridData) throw new Error('NWS points response has no forecast links');
  const gp = grid?.properties, fp = forecast?.properties;
  const gridElev = gp?.elevation ?? fp?.elevation;
  const [validFrom, validTo] = interval(gp?.validTimes || fp?.validTimes) || [null, null];
  return {
    source: 'NOAA National Weather Service', sourceUrl: NWS.page(lat, lon), apiUrl: `${NWS.api}/points/${lat.toFixed(4)},${lon.toFixed(4)}`,
    retrievedAt, issuedAt: gp?.updateTime || fp?.updateTime || null, validFrom: iso(validFrom), validTo: iso(validTo),
    office: String(pp.gridId || ''), gridX: pp.gridX ?? null, gridY: pp.gridY ?? null, timeZone: pp.timeZone || null,
    point: {lon, lat, elevationM: finite(elevationM) ? elevationM : null},
    grid: {elevationM: gridElev?.unitCode === 'wmoUnit:m' && finite(gridElev.value) ? gridElev.value : null, cellKm: 2.5},
    periods: normalizePeriods(fp), series: gp ? normalizeGrid(gp) : null,
    parts: {forecast: fp ? 'ok' : 'unavailable', grid: gp ? 'ok' : 'unavailable'}
  };
}

/** State of a normalized object at time now. */
export function nwsState(v, now = Date.now()) {
  if (validityState(v, now) === 'expired') return {state: 'expired', message: 'The NWS forecast period has ended.'};
  const issued = toMs(v.issuedAt);
  if (issued !== null && now - issued > NWS.staleAfterMs) return {state: 'stale', message: `NWS last updated this forecast ${ageText(v.issuedAt, now)}.`};
  return {state: 'ok', message: ''};
}

/**
 * NWS forecast for a place. Never throws. Returns the normalized object with `state` and `message`, plus
 * `alerts` {state, items} kept separate (alerts are never served from a saved copy).
 * net: request options (fetchImpl, timeout, retries, baseMs), mainly for tests.
 */
export async function getNws({lon, lat, elevationM}, {signal, now = Date.now(), net = {}} = {}) {
  const o = {...net, signal, headers: HEADERS};
  const pointUrl = `${NWS.api}/points/${lat.toFixed(4)},${lon.toFixed(4)}`;
  const alertsP = request(`${NWS.api}/alerts/active?point=${lat.toFixed(4)},${lon.toFixed(4)}`, o)
    .then(a => ({state: 'ok', items: normalizeAlerts(a), retrievedAt: iso(now)}), e => ({state: e.kind === 'aborted' ? 'aborted' : 'unavailable', items: [], message: e.message}));
  let outside = null;
  const res = await withLastGood('nws', placeKey(lon, lat), async () => {
    const points = await request(pointUrl, o).catch(e => { if (e.status === 404) outside = e; throw e; });
    const [fc, gr] = await Promise.allSettled([request(points.properties.forecast, o), request(points.properties.forecastGridData, o)]);
    if (fc.status === 'rejected' && gr.status === 'rejected') throw fc.reason;
    return normalizeNws({points, forecast: fc.value, grid: gr.value}, {lon, lat, elevationM, retrievedAt: iso(now)});
  }, {maxAgeMs: NWS.keepMs, now});
  const alerts = await alertsP;
  if (res.aborted) return {state: 'aborted', source: 'NOAA National Weather Service', alerts};
  if (outside) return {state: 'outside-coverage', source: 'NOAA National Weather Service', sourceUrl: NWS.page(lat, lon), message: 'NWS has no forecast grid for this point.', alerts};
  if (!res.value) return {state: 'unavailable', source: 'NOAA National Weather Service', sourceUrl: NWS.page(lat, lon), message: `NWS forecast could not be loaded (${res.error?.message}).`, alerts};
  const v = {...res.value, point: {lon, lat, elevationM: finite(elevationM) ? elevationM : res.value.point?.elevationM ?? null}};
  const base = nwsState(v, now);
  const st = res.cached && base.state !== 'expired'
    ? {state: 'stale', message: `Live request failed (${res.error?.message}). Showing the copy saved on this device ${ageText(res.savedAt, now)}.`} : base;
  return {...v, ...st, cached: !!res.cached, savedAt: iso(res.savedAt), alerts};
}
