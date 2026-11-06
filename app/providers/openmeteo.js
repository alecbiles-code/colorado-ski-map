// Open-Meteo forecast adapter (model output, not observations). One request per place: hourly variables from
// Open-Meteo's best_match model selection, in SI. Daily and 24/48 h totals are computed here from the hourly values with the
// weather app's null-safe accumulation (core.js integrate, commit 914f4aa): hourly precipitation and snowfall at
// time t are the amounts in (t - 1 h, t], and a window with any missing hour has no total.
//
// Elevation, verified 2026-11-06 at Berthoud Pass: Open-Meteo returns the centre of the model grid cell it used
// (latitude/longitude) and, by default, adjusts 2 m temperature from the cell height to the elevation of its own
// 90 m DEM at the requested point (elevation=nan disables that and uses the mean cell height). Passing
// `elevation` replaces the DEM value as the target of that adjustment. Only temperature changed; wind,
// precipitation, snowfall, cloud and freezing level were identical. We pass the point's elevation when known.

import {CONFIG} from '../config.js';
import {request, withLastGood, placeKey} from './fetch.js';
import {iso, toMs, ageText, dayBounds, localDate, shiftDate, HOUR} from '../lib/time.js';
import {finite} from '../lib/units.js';
import {distanceM} from '../lib/geo.js';

export const OPEN_METEO = Object.freeze({
  api: CONFIG.providers.openMeteo.api,
  model: 'best_match',
  modelLabel: 'Open-Meteo best match (Open-Meteo chooses and blends the models for this location)',
  sourceUrl: CONFIG.providers.openMeteo.docs,
  attribution: 'Weather data by Open-Meteo.com',
  attributionUrl: CONFIG.providers.openMeteo.home,
  license: 'CC BY 4.0',
  days: 8, // requested; the last local day is one hour short, so 7 complete days are kept
  keepMs: 24 * HOUR
});
const HOURLY = ['temperature_2m', 'wind_speed_10m', 'wind_direction_10m', 'wind_gusts_10m', 'weather_code', 'precipitation', 'rain', 'showers',
  'snowfall', 'cloud_cover', 'freezing_level_height'];
const EXPECT_UNITS = {temperature_2m: '°C', wind_speed_10m: 'm/s', wind_gusts_10m: 'm/s', precipitation: 'mm', rain: 'mm', showers: 'mm', snowfall: 'cm', freezing_level_height: 'm'};

export function forecastUrl({lon, lat, elevationM}) {
  const p = new URLSearchParams({latitude: lat.toFixed(4), longitude: lon.toFixed(4), hourly: HOURLY.join(','), models: OPEN_METEO.model,
    timezone: 'America/Denver', timeformat: 'unixtime', forecast_days: String(OPEN_METEO.days),
    wind_speed_unit: 'ms', temperature_unit: 'celsius', precipitation_unit: 'mm'});
  if (finite(elevationM)) p.set('elevation', elevationM.toFixed(0));
  return `${OPEN_METEO.api}?${p}`;
}

/* ---- Weather codes (WMO 4677 subset used by Open-Meteo) ---- */
const SNOW_CODES = new Set([71, 73, 75, 77, 85, 86]), FRZ_CODES = new Set([56, 57, 66, 67]);
const RAIN_CODES = new Set([51, 53, 55, 61, 63, 65, 80, 81, 82]), STORM_CODES = new Set([95, 96, 99]);
const LABELS = {0: 'Clear', 1: 'Mainly clear', 2: 'Partly cloudy', 3: 'Overcast', 45: 'Fog', 48: 'Rime fog', 51: 'Light drizzle', 53: 'Drizzle',
  55: 'Heavy drizzle', 56: 'Freezing drizzle', 57: 'Freezing drizzle', 61: 'Light rain', 63: 'Rain', 65: 'Heavy rain', 66: 'Freezing rain',
  67: 'Freezing rain', 71: 'Light snow', 73: 'Snow', 75: 'Heavy snow', 77: 'Snow grains', 80: 'Rain showers', 81: 'Rain showers',
  82: 'Heavy rain showers', 85: 'Snow showers', 86: 'Heavy snow showers', 95: 'Thunderstorm', 96: 'Thunderstorm, hail', 99: 'Thunderstorm, hail'};
export const weatherLabel = code => (finite(code) ? LABELS[code] || `Code ${code}` : null);

/**
 * Precipitation type for one hour from its amounts first, then its weather code:
 * 'snow' | 'rain' | 'freezing rain' | 'mixed' | 'thunderstorm' | 'none', or null when nothing is known.
 */
export function precipType({snowCm, rainMm, showersMm, code}) {
  const liquid = finite(rainMm) || finite(showersMm) ? (rainMm || 0) + (showersMm || 0) : null;
  const s = snowCm > 0, r = liquid > 0;
  if (s && r) return 'mixed';
  if (s) return 'snow';
  if (r) return FRZ_CODES.has(code) ? 'freezing rain' : STORM_CODES.has(code) ? 'thunderstorm' : 'rain';
  if (SNOW_CODES.has(code)) return 'snow';
  if (FRZ_CODES.has(code)) return 'freezing rain';
  if (RAIN_CODES.has(code)) return 'rain';
  if (STORM_CODES.has(code)) return 'thunderstorm';
  return finite(snowCm) || liquid !== null || finite(code) ? 'none' : null;
}

/* ---- Null-safe accumulation (ported from weather core.js) ---- */
/** Sum of an hourly accumulation field over [start, end); null unless every hour is present. Hours carry t (ms, end of hour). */
export function integrate(hours, start, end, field) {
  let total = 0, covered = 0;
  for (const h of hours) {
    const overlap = Math.max(0, Math.min(end, h.t) - Math.max(start, h.t - HOUR));
    if (!overlap) continue;
    if (finite(h[field]) && h[field] >= 0) { total += h[field] * overlap / HOUR; covered += overlap; }
  }
  return end > start && covered / (end - start) > 0.999999 ? total : null;
}
/**
 * Min or max of samples in a window; null unless every hour is present. Instantaneous fields use t in [start, end);
 * `ending` fields (gusts: the maximum of the preceding hour) use t in (start, end].
 */
export function sampleStat(hours, start, end, field, fn, ending = false) {
  const vals = hours.filter(h => (ending ? h.t > start && h.t <= end : h.t >= start && h.t < end)).map(h => h[field]);
  if (vals.length < Math.round((end - start) / HOUR) || !vals.every(finite)) return null;
  return fn(...vals);
}
/** Window summary over [start, end). */
export function summarize(hours, start, end) {
  return {from: iso(start), to: iso(end), snowCm: integrate(hours, start, end, 'snowCm'), precipMm: integrate(hours, start, end, 'precipMm'),
    tMinC: sampleStat(hours, start, end, 'tempC', Math.min), tMaxC: sampleStat(hours, start, end, 'tempC', Math.max),
    gustMaxMs: sampleStat(hours, start, end, 'gustMs', Math.max, true), windMaxMs: sampleStat(hours, start, end, 'windMs', Math.max),
    freezingMinM: sampleStat(hours, start, end, 'freezingM', Math.min), freezingMaxM: sampleStat(hours, start, end, 'freezingM', Math.max)};
}

function checkUnits(u) {
  for (const [k, want] of Object.entries(EXPECT_UNITS)) if (u?.[k] && u[k] !== want) throw new Error(`Unexpected Open-Meteo unit for ${k}: ${u[k]}`);
}
const num = v => (finite(v) ? v : null);
const nonneg = v => (finite(v) && v >= 0 ? v : null);

/** Pure: raw Open-Meteo response to the normalized object (hours with ISO `time`, Colorado days, now/24/48 h). */
export function normalizeOpenMeteo(raw, {lon, lat, elevationM = null, retrievedAt, now = Date.now()}) {
  const h = raw?.hourly;
  if (!Array.isArray(h?.time) || h.time.length < 2) throw new Error('Open-Meteo response has no hourly timeline');
  checkUnits(raw.hourly_units);
  const rows = h.time.map((t, i) => {
    if (!finite(t)) throw new Error('Expected epoch timestamps');
    const r = {t: t * 1000, tempC: num(h.temperature_2m?.[i]), windMs: nonneg(h.wind_speed_10m?.[i]), gustMs: nonneg(h.wind_gusts_10m?.[i]),
      windDirDeg: num(h.wind_direction_10m?.[i]), code: num(h.weather_code?.[i]), precipMm: nonneg(h.precipitation?.[i]), rainMm: nonneg(h.rain?.[i]),
      showersMm: nonneg(h.showers?.[i]), snowCm: nonneg(h.snowfall?.[i]), cloudPct: num(h.cloud_cover?.[i]), freezingM: num(h.freezing_level_height?.[i])};
    r.ptype = precipType(r);
    return r;
  }).sort((a, b) => a.t - b.t);
  if (rows.some((r, i) => i && r.t - rows[i - 1].t !== HOUR)) throw new Error('Open-Meteo timeline is not hourly');
  const days = [], end = rows.at(-1).t;
  for (let d = localDate(rows[0].t); dayBounds(d)[1] <= end; d = shiftDate(d, 1)) { const [a, b] = dayBounds(d); days.push({date: d, ...summarize(rows, a, b)}); }
  const hourStart = Math.floor(now / HOUR) * HOUR;
  const grid = {lon: num(raw.longitude), lat: num(raw.latitude)};
  return {
    source: 'Open-Meteo', model: OPEN_METEO.model, modelLabel: OPEN_METEO.modelLabel, sourceUrl: OPEN_METEO.sourceUrl, attribution: OPEN_METEO.attribution, attributionUrl: OPEN_METEO.attributionUrl,
    apiUrl: forecastUrl({lon, lat, elevationM}), retrievedAt, issuedAt: null, validFrom: iso(rows[0].t), validTo: iso(rows.at(-1).t),
    point: {lon, lat, elevationM: finite(elevationM) ? elevationM : null},
    grid: {...grid, distanceM: finite(grid.lon) && finite(grid.lat) ? distanceM([lon, lat], [grid.lon, grid.lat]) : null,
      temperatureElevationM: num(raw.elevation), temperatureElevationSource: finite(elevationM) ? 'selected point' : 'Open-Meteo 90 m DEM at the point'},
    hours: rows.map(({t, ...r}) => ({time: iso(t), ...r})), days,
    next24: summarize(rows, hourStart, hourStart + 24 * HOUR), next48: summarize(rows, hourStart, hourStart + 48 * HOUR)
  };
}

/** The hourly row closest to now (instantaneous values), or null. */
export function currentHour(v, now = Date.now()) {
  let best = null;
  for (const h of v?.hours || []) { const d = Math.abs(toMs(h.time) - now); if (d <= HOUR && (!best || d < best.d)) best = {d, h}; }
  return best?.h || null;
}

/** Open-Meteo forecast for a place. Never throws; returns the normalized object with `state` and `message`. */
export async function getOpenMeteo({lon, lat, elevationM}, {signal, now = Date.now(), net = {}} = {}) {
  const res = await withLastGood('openmeteo', `${placeKey(lon, lat)}@${finite(elevationM) ? Math.round(elevationM) : ''}`, async () => {
    const raw = await request(forecastUrl({lon, lat, elevationM}), {...net, signal});
    return normalizeOpenMeteo(raw, {lon, lat, elevationM, retrievedAt: iso(now), now});
  }, {maxAgeMs: OPEN_METEO.keepMs, now});
  if (res.aborted) return {state: 'aborted', source: 'Open-Meteo'};
  if (!res.value) return {state: 'unavailable', source: 'Open-Meteo', sourceUrl: OPEN_METEO.sourceUrl, message: `Open-Meteo forecast could not be loaded (${res.error?.message}).`};
  const v = res.value;
  if (toMs(v.validTo) <= now) return {...v, state: 'expired', message: 'The saved Open-Meteo forecast has run out.'};
  if (!res.cached) return {...v, state: 'ok', message: '', cached: false};
  // A saved copy: recompute the windows from now so "next 24 h" is not the saved copy's next 24 h.
  const rows = v.hours.map(h => ({...h, t: toMs(h.time)})), hs = Math.floor(now / HOUR) * HOUR;
  return {...v, next24: summarize(rows, hs, hs + 24 * HOUR), next48: summarize(rows, hs, hs + 48 * HOUR), state: 'stale', cached: true, savedAt: iso(res.savedAt),
    message: `Live request failed (${res.error?.message}). Showing the copy saved on this device ${ageText(res.savedAt, now)}.`};
}
