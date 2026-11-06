// NRCS SNOTEL adapter (AWDB REST, keyless): nearest stations from the static station list, a batched latest
// reading for those stations, and on demand one station's daily (30 days) and hourly (7 days) history.
// Facts verified against the live API on 2026-11-06 (docs/methods/conditions.md):
// 1. Timestamps are station clock times in a fixed offset given by the station's dataTimeZone (-8.0, Pacific
//    Standard Time, for every active Colorado SNOTEL station), never shifted for DST.
// 2. A daily value dated D is the reading at 00:00 ending D (it equals the hourly reading at D+1 00:00), as the
//    weather app's measuredDay semantics assume.
// 3. PREC is accumulated precipitation since the water year began (Oct 1); intervals are differences.
// 4. QC flags (NRCS report header): V valid, N no profile, E edit for sensor noise, K estimate, C correction,
//    B back estimate, X external estimate, S suspect, M missing. QA: U unknown, R raw, P provisional, A approved.
// Raw readings are kept apart from derived changes. Suspect, missing and implausible readings are labeled and
// never enter a change; a depth change is a change in depth, not new snowfall.

import {CONFIG} from '../config.js';
import {request, withLastGood, SLOW_TIMEOUT} from './fetch.js';
import {iso, toMs, withOffset, shiftDate, ageText, HOUR, DAY} from '../lib/time.js';
import {finite, fToC} from '../lib/units.js';
import {distanceM} from '../lib/geo.js';

export const SNOTEL = Object.freeze({
  api: CONFIG.providers.snotel.api,
  stationsUrl: CONFIG.providers.snotel.stationsUrl,
  stationPage: id => `${CONFIG.providers.snotel.stationPage}?sitenum=${encodeURIComponent(id)}`,
  /** Verified 2026-11-06: the stations endpoint gave dataTimeZone -8.0 for all 118 active CO SNTL stations. */
  fallbackTimeZone: -8,
  delayedAfterMs: 6 * HOUR,
  keepMs: 3 * DAY
});
const ELEMENTS = {
  // Plausibility bounds are judgment knobs (docs/sources/conditions.md 3.7), not NRCS constants: depth 0 to 400 in,
  // SWE 0 to 150 in, air temperature -60 to 100 F; applied to flagged and unflagged data alike.
  SNWD: {unit: 'in', to: v => v * 2.54, min: 0, max: 400 * 2.54, label: 'Snow depth'}, // cm
  WTEQ: {unit: 'in', to: v => v * 25.4, min: 0, max: 150 * 25.4, label: 'Snow water equivalent'}, // mm
  PREC: {unit: 'in', to: v => v * 25.4, min: 0, max: 5000, label: 'Precipitation since Oct 1'}, // mm
  TOBS: {unit: 'degF', to: fToC, min: fToC(-60), max: fToC(100), label: 'Air temperature'}, // degC
  TMAX: {unit: 'degF', to: fToC, min: fToC(-60), max: fToC(100), label: 'Daily high'},
  TMIN: {unit: 'degF', to: fToC, min: fToC(-60), max: fToC(100), label: 'Daily low'}
};
const ESTIMATED = new Set(['E', 'K', 'C', 'B', 'X']);

/* ---- Station list and nearest stations ---- */
/** Station from data/snow/snotel-stations.geojson (schemas/station.schema.json): upstreamId is the AWDB triplet. */
export function stationInfo(f) {
  const p = f?.properties || {}, c = f?.geometry?.coordinates;
  const triplet = String(p.upstreamId || '');
  return {triplet, id: triplet.split(':')[0], name: String(p.name || triplet), network: String(p.network || ''), lon: c?.[0], lat: c?.[1],
    elevationM: finite(p.elevationM) ? p.elevationM : null, dataTimeZone: finite(p.dataTimeZoneOffsetHours) ? p.dataTimeZoneOffsetHours : null,
    elements: p.elements && typeof p.elements === 'object' ? Object.keys(p.elements) : null};
}
/** Nearest n stations within maxKm of a place, with distance and elevation difference (station minus place). */
export function nearestStations(place, features, {n = 5, maxKm = 60} = {}) {
  return (features || []).map(stationInfo).filter(s => s.triplet && finite(s.lon) && finite(s.lat))
    .map(s => ({...s, distanceM: distanceM([place.lon, place.lat], [s.lon, s.lat]),
      elevationDiffM: finite(s.elevationM) && finite(place.elevationM) ? s.elevationM - place.elevationM : null}))
    .filter(s => s.distanceM <= maxKm * 1000).sort((a, b) => a.distanceM - b.distanceM).slice(0, n);
}

/* ---- Readings ---- */
/** One AWDB value to a reading with SI value, station-offset time and a quality label. */
export function reading(code, v, tz, daily) {
  const el = ELEMENTS[code], qc = v?.qcFlag || null, qa = v?.qaFlag || null;
  const when = daily ? withOffset(`${shiftDate(String(v?.date).slice(0, 10), 1)} 00:00`, tz) : withOffset(String(v?.date || ''), tz);
  const raw = finite(v?.value) ? v.value : null;
  const value = raw === null ? null : el.to(raw);
  const quality = raw === null || qc === 'M' ? 'missing' : qc === 'S' ? 'suspect' : value < el.min || value > el.max ? 'implausible' : ESTIMATED.has(qc) ? 'estimated' : 'ok';
  const r = {observedAt: when, value: quality === 'missing' ? null : value, rawValue: raw, rawUnit: el.unit, qc, qa, quality, usable: quality === 'ok' || quality === 'estimated'};
  if (daily) r.date = String(v.date).slice(0, 10);
  return r;
}
/** AWDB data response for one station to {CODE: readings[]} (sorted by time). Wrong units drop the element. */
export function parseSeries(raw, triplet, tz, daily) {
  const item = Array.isArray(raw) ? raw.find(s => s.stationTriplet === triplet) : null;
  if (!item) return null;
  const out = {};
  for (const block of item.data || []) {
    const code = block.stationElement?.elementCode, el = ELEMENTS[code];
    if (!el || block.error || block.stationElement?.storedUnitCode !== el.unit) continue;
    out[code] = (block.values || []).map(v => reading(code, v, tz, daily)).filter(r => r.observedAt).sort((a, b) => toMs(a.observedAt) - toMs(b.observedAt));
  }
  return out;
}
/** Latest usable reading of a series, or the latest reading of any kind marked unusable, or null. */
export function latest(series) {
  const u = (series || []).filter(r => r.usable).at(-1);
  return u || (series || []).at(-1) || null;
}
/** Water-year start (Oct 1) of a calendar date. */
const waterYear = d => (d.slice(5) >= '10-01' ? Number(d.slice(0, 4)) : Number(d.slice(0, 4)) - 1);

/**
 * Change of a series over the window ending at its latest usable reading: {from, to, delta, reason}.
 * delta is null when either end is missing or unusable (reason says why). For PREC, a window across the
 * Oct 1 water-year reset, or a negative difference, has no value.
 */
export function change(series, windowMs, code) {
  const end = (series || []).filter(r => r.usable).at(-1);
  if (!end) return {from: null, to: null, delta: null, reason: 'no usable reading'};
  const target = toMs(end.observedAt) - windowMs;
  const start = series.find(r => Math.abs(toMs(r.observedAt) - target) < 1000);
  const base = {from: iso(target), to: end.observedAt};
  if (!start || !start.usable) return {...base, delta: null, reason: start ? `reading at start is ${start.quality}` : 'no reading at start'};
  if (code === 'PREC') {
    const d0 = start.date || start.observedAt.slice(0, 10), d1 = end.date || end.observedAt.slice(0, 10);
    if (waterYear(d0) !== waterYear(d1)) return {...base, delta: null, reason: 'window crosses the Oct 1 water-year reset'};
    if (end.value < start.value) return {...base, delta: null, reason: 'gauge total fell (reset or error)'};
  }
  return {...base, delta: end.value - start.value, reason: null};
}

/* ---- Requests ---- */
/** Station clock date (YYYY-MM-DD) at an instant, for AWDB beginDate/endDate. */
export const stationDate = (ms, tz) => new Date(ms + tz * HOUR).toISOString().slice(0, 10);
export function dataUrl(triplets, elements, duration, beginDate, endDate) {
  const p = new URLSearchParams({stationTriplets: triplets.join(','), elements: elements.join(','), duration, beginDate, endDate,
    returnFlags: 'true', returnSuspectData: 'true'});
  return `${SNOTEL.api}/data?${p}`;
}

/** Latest hourly depth, SWE and temperature for several stations in one request. Never throws. */
export async function getLatest(stations, {signal, now = Date.now(), net = {}} = {}) {
  if (!stations?.length) return {state: 'ok', byTriplet: {}};
  const tz = SNOTEL.fallbackTimeZone;
  const url = dataUrl(stations.map(s => s.triplet), ['SNWD', 'WTEQ', 'TOBS'], 'HOURLY', stationDate(now - 2 * DAY, tz), stationDate(now + DAY, tz));
  try {
    const raw = await request(url, {timeout: SLOW_TIMEOUT, ...net, signal});
    const byTriplet = {};
    for (const s of stations) {
      const ser = parseSeries(raw, s.triplet, finite(s.dataTimeZone) ? s.dataTimeZone : tz, false) || {};
      const pick = code => { const r = latest(ser[code]); return r ? {...r, delayed: now - toMs(r.observedAt) > SNOTEL.delayedAfterMs} : null; };
      byTriplet[s.triplet] = {depth: pick('SNWD'), swe: pick('WTEQ'), temp: pick('TOBS')};
    }
    return {state: 'ok', byTriplet, retrievedAt: iso(now)};
  } catch (e) {
    return {state: e.kind === 'aborted' ? 'aborted' : 'unavailable', byTriplet: {}, message: `SNOTEL readings could not be loaded (${e.message}).`};
  }
}

async function loadDetail(st, {signal, now, net}) {
  const o = {timeout: SLOW_TIMEOUT, ...net, signal};
  const meta = await request(`${SNOTEL.api}/stations?stationTriplets=${encodeURIComponent(st.triplet)}`, o).catch(e => { if (e.kind === 'aborted') throw e; return null; });
  const m = Array.isArray(meta) ? meta.find(x => x.stationTriplet === st.triplet) : null;
  const tz = finite(m?.dataTimeZone) ? m.dataTimeZone : finite(st.dataTimeZone) ? st.dataTimeZone : SNOTEL.fallbackTimeZone;
  const end = stationDate(now + DAY, tz);
  const [daily, hourly] = await Promise.all([
    request(dataUrl([st.triplet], ['SNWD', 'WTEQ', 'PREC', 'TMAX', 'TMIN'], 'DAILY', stationDate(now - 32 * DAY, tz), end), o),
    request(dataUrl([st.triplet], ['SNWD', 'WTEQ', 'PREC', 'TOBS'], 'HOURLY', stationDate(now - 8 * DAY, tz), end), o)]);
  const d = parseSeries(daily, st.triplet, tz, true), h = parseSeries(hourly, st.triplet, tz, false);
  if (!d && !h) throw Object.assign(new Error('No data for this station in the response'), {kind: 'parse'});
  return {triplet: st.triplet, name: m?.name || st.name, lon: finite(m?.longitude) ? m.longitude : st.lon, lat: finite(m?.latitude) ? m.latitude : st.lat,
    elevationM: finite(m?.elevation) ? m.elevation * 0.3048 : st.elevationM, dataTimeZone: tz, timeZoneSource: m ? 'AWDB station metadata' : 'assumed (metadata request failed)',
    daily: d || {}, hourly: h || {}, retrievedAt: iso(now)};
}

/** Derived changes and latest readings for a station detail object. */
export function summarizeStation(v, now = Date.now()) {
  const out = {};
  for (const code of ['SNWD', 'WTEQ', 'PREC', 'TOBS']) {
    const h = v.hourly?.[code], d = v.daily?.[code], last = latest(h) || latest(d);
    out[code] = {latest: last ? {...last, delayed: now - toMs(last.observedAt) > SNOTEL.delayedAfterMs} : null};
    if (code === 'TOBS') continue;
    out[code].change24h = change(h, DAY, code);
    out[code].change7d = change(h, 7 * DAY, code);
    out[code].change30d = change(d, 30 * DAY, code);
  }
  return out;
}

/** One station's history and summary. Never throws. */
export async function getStationDetail(station, {signal, now = Date.now(), net = {}} = {}) {
  const st = station?.properties ? stationInfo(station) : station;
  const head = {source: 'NRCS SNOTEL (AWDB)', sourceUrl: SNOTEL.stationPage(String(st?.triplet || '').split(':')[0]), triplet: st?.triplet};
  if (!st?.triplet) return {...head, state: 'error', message: 'Station has no triplet id.'};
  const res = await withLastGood('snotel', st.triplet, () => loadDetail(st, {signal, now, net}), {maxAgeMs: SNOTEL.keepMs, now});
  if (res.aborted) return {...head, state: 'aborted'};
  if (!res.value) return {...head, state: res.error?.kind === 'parse' ? 'error' : 'unavailable', message: `Station data could not be loaded (${res.error?.message}).`};
  const v = res.value, summary = summarizeStation(v, now);
  const st2 = res.cached ? {state: 'stale', message: `Live request failed (${res.error?.message}). Showing the copy saved on this device ${ageText(res.savedAt, now)}.`} : {state: 'ok', message: ''};
  return {...head, ...v, ...st2, cached: !!res.cached, savedAt: iso(res.savedAt), summary};
}

/** Load the static station list. Never throws. */
export async function loadStations({url = SNOTEL.stationsUrl, signal, net = {}} = {}) {
  try {
    const fc = await request(url, {retries: 1, ...net, signal});
    if (!Array.isArray(fc?.features)) throw new Error('Station list is not a FeatureCollection');
    return {state: 'ok', features: fc.features};
  } catch (e) {
    return {state: e.kind === 'aborted' ? 'aborted' : 'unavailable', features: [], message: `SNOTEL station list could not be loaded (${e.message}).`};
  }
}
