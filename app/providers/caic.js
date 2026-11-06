// CAIC avalanche forecast adapter (avalanche.org map layer), behind CONFIG.providers.caic.enabled, and the detailed
// product endpoint behind its own switch (CONFIG.providers.caic.product.enabled). Both default off: the API root page
// asks users to contact avalanche.org for permission and CAIC content needs written permission (docs/sources/conditions.md 2.1).
// The official link works with the adapter off and is always shown. Nothing here derives a rating from weather
// or terrain. Each zone keeps its own issue and expiry times; expired, not-yet-valid, no-rating,
// outside-coverage, boundary-overlap, no-product and unavailable are distinct states, and only a current zone
// with a published level 1 to 5 is ever reported as a rating.
// Map-layer start_date/end_date carry no offset but are UTC: the product endpoint gives the same clock values
// with +00:00 (weather app 2026-10-21; re-checked 2026-11-06: map layer 2026-11-05T23:30:00, product
// published_time 2026-11-05T23:30:00+00:00).

import {CONFIG} from '../config.js';
import {request, withLastGood} from './fetch.js';
import {iso, toMs, validityState, ageText, DAY} from '../lib/time.js';
import {finite} from '../lib/units.js';
import {distanceM, pointInGeometry} from '../lib/geo.js';

const API = CONFIG.providers.caic.api;
const OFFICIAL = CONFIG.providers.officialLinks.caicForecast;
export const CAIC = Object.freeze({
  mapLayer: `${API}/products/map-layer/CAIC`,
  product: zoneId => `${API}/product?type=forecast&center_id=CAIC&zone_id=${encodeURIComponent(zoneId)}`,
  official: OFFICIAL,
  /** CAIC's forecast map reads ?lat=&lng= and opens the containing area (docs/sources/conditions.md 2.1.4, tested 2026-11-06). */
  officialAt: (lon, lat) => `${OFFICIAL}?lat=${lat.toFixed(4)}&lng=${lon.toFixed(4)}`,
  keepMs: 2 * DAY,
  sampleM: 200 // route lines are checked at least every 200 m
});
export const DANGER_NAMES = ['', 'Low', 'Moderate', 'Considerable', 'High', 'Extreme'];

/** Official CAIC link for a point, or the CAIC home page. Works with the adapter off. */
export const officialLink = place => (finite(place?.lon) && finite(place?.lat) ? CAIC.officialAt(place.lon, place.lat) : CAIC.official);
/** Map-layer time without offset is UTC. */
const utc = s => (typeof s === 'string' && s && !/(?:Z|[+-]\d\d:?\d\d)$/i.test(s) ? `${s}Z` : s || null);

/** One map-layer feature to a zone record with its own times and display state. */
export function normalizeZone(f, now = Date.now()) {
  const p = f?.properties || {}, n = Number(p.danger_level);
  const validFrom = iso(toMs(utc(p.start_date))), validTo = iso(toMs(utc(p.end_date)));
  const validity = validityState({validFrom, validTo}, now);
  const level = Number.isInteger(n) && n >= 1 && n <= 5 ? n : null;
  const display = validity !== 'current' ? (validity === 'unknown' ? 'unknown-validity' : validity) : p.off_season || level === null ? 'no-rating' : 'rated';
  return {zoneId: f?.id ?? null, name: String(p.name || 'CAIC zone'), center: String(p.center || 'CAIC'), validFrom, validTo, issuedAt: validFrom,
    validity, display, dangerLevel: display === 'rated' ? level : null, publishedLevel: level, danger: String(p.danger || ''),
    offSeason: !!p.off_season, travelAdvice: String(p.travel_advice || ''), warning: p.warning?.product ? String(p.warning.product) : null,
    link: typeof p.link === 'string' && /^https:\/\//.test(p.link) ? p.link : CAIC.official};
}

/** Zones whose geometry contains [lon, lat]. */
export const zonesAt = (features, pt) => (features || []).filter(f => pointInGeometry(pt, f.geometry));

/** Points along a line no more than stepM apart (vertices kept). */
export function samplePoints(coords, stepM = CAIC.sampleM) {
  const out = [];
  coords.forEach((c, i) => {
    if (i) {
      const a = coords[i - 1], k = Math.ceil(distanceM(a, c) / stepM);
      for (let j = 1; j < k; j++) out.push([a[0] + (c[0] - a[0]) * j / k, a[1] + (c[1] - a[1]) * j / k]);
    }
    out.push([c[0], c[1]]);
  });
  return out;
}

/**
 * Resolve a place against the zones of one map-layer response (geometry and ratings from the same response).
 * Point: {state: 'outside-coverage' | 'boundary-overlap' | zone.display, zones}.
 * Line: also {route: {zones (each with officialUrl at its first route point), samples, outside, overlap}}.
 */
export function resolvePlace(features, place, now = Date.now()) {
  const at = zonesAt(features, [place.lon, place.lat]).map(f => normalizeZone(f, now));
  const point = {state: at.length === 0 ? 'outside-coverage' : at.length > 1 ? 'boundary-overlap' : at[0].display, zones: at};
  const coords = place.line?.type === 'LineString' && Array.isArray(place.line.coordinates) ? place.line.coordinates : null;
  if (!coords?.length) return {point, route: null};
  const seen = new Map();
  let outside = 0, overlap = 0;
  const samples = samplePoints(coords);
  for (const pt of samples) {
    const z = zonesAt(features, pt);
    if (!z.length) outside++;
    if (z.length > 1) overlap++;
    for (const f of z) if (!seen.has(f)) seen.set(f, {...normalizeZone(f, now), officialUrl: CAIC.officialAt(pt[0], pt[1])});
  }
  return {point, route: {zones: [...seen.values()], samples: samples.length, outside, overlap}};
}

/** Strip HTML to plain text (rendered later with textContent, never as HTML). */
export function plainText(html) {
  const ent = {amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'"};
  return String(html || '').replace(/<\/(p|li|div|h\d)>|<br\s*\/?>/gi, '\n').replace(/<[^>]*>/g, '')
    .replace(/&(amp|lt|gt|quot|apos|nbsp|#39);/g, (_, k) => ent[k]).replace(/\n{3,}/g, '\n\n').trim();
}
/**
 * Detailed forecast product for a zone, kept only when it belongs to the same publication as the map-layer zone
 * (same valid-from and valid-to, the product lists this zone id) and has not expired; otherwise {state: 'mismatch'}
 * or {state: 'expired'}. HTTP 200 does not mean current: disabled zones return old products.
 */
export function normalizeProduct(raw, zone, now = Date.now()) {
  if (!raw?.id || !raw.published_time) return {state: 'no-product'};
  const publishedAt = iso(toMs(raw.published_time)), expiresAt = iso(toMs(raw.expires_time));
  if (!(toMs(expiresAt) > now)) return {state: 'expired', publishedAt, expiresAt};
  const areas = Array.isArray(raw.forecast_zone) ? raw.forecast_zone : [];
  if (publishedAt !== zone.validFrom || expiresAt !== zone.validTo || !areas.some(a => a?.id === zone.zoneId)) return {state: 'mismatch', publishedAt, expiresAt};
  const lvl = v => (Number.isInteger(v) && v >= 1 && v <= 5 ? v : null);
  return {state: 'ok', id: raw.id, publishedAt, expiresAt, author: String(raw.author || ''), bottomLine: plainText(raw.bottom_line),
    areaNames: [...new Set(areas.map(a => String(a?.name || '')).filter(Boolean))],
    danger: (raw.danger || []).map(d => ({day: String(d.valid_day || ''), upper: lvl(d.upper), middle: lvl(d.middle), lower: lvl(d.lower)})),
    problems: (raw.forecast_avalanche_problems || []).sort((a, b) => (a.rank ?? 9) - (b.rank ?? 9)).map(p => ({name: String(p.name || ''),
      likelihood: String(p.likelihood || ''), size: (p.size || []).map(Number).filter(finite), locations: (p.location || []).map(String)}))};
}

/**
 * CAIC forecast for a place. Never throws. With the adapter off, returns {state: 'disabled'} and the official link.
 * Options: enabled (CONFIG.providers.caic.enabled), detail (CONFIG.providers.caic.product.enabled: also fetch the
 * product for a single current zone).
 */
export async function getCaic(place, {enabled = false, detail = false, signal, now = Date.now(), net = {}} = {}) {
  const head = {source: 'Colorado Avalanche Information Center (CAIC)', officialUrl: officialLink(place), enabled};
  if (!enabled) return {...head, state: 'disabled', message: 'Forecast feed is switched off. Open the official CAIC forecast.'};
  const res = await withLastGood('caic', 'map-layer', async () => {
    const fc = await request(CAIC.mapLayer, {...net, signal});
    if (!Array.isArray(fc?.features)) throw Object.assign(new Error('Map layer has no features'), {kind: 'parse'});
    return {features: fc.features, retrievedAt: iso(now)};
  }, {maxAgeMs: CAIC.keepMs, now});
  if (res.aborted) return {...head, state: 'aborted'};
  if (!res.value) return {...head, state: 'unavailable', message: `CAIC forecast feed could not be loaded (${res.error?.message}). Missing is not low danger.`};
  if (!res.value.features.length) return {...head, state: 'no-product', retrievedAt: res.value.retrievedAt, message: 'The feed has no forecast zones right now.'};
  const r = resolvePlace(res.value.features, place, now);
  const out = {...head, ...r, state: r.point.state, retrievedAt: res.value.retrievedAt, cached: !!res.cached, savedAt: iso(res.savedAt),
    message: res.cached ? `Live request failed (${res.error?.message}). Using the feed saved on this device ${ageText(res.savedAt, now)}; each zone is checked against its own expiry.` : ''};
  const z = r.point.zones.length === 1 ? r.point.zones[0] : null;
  if (detail && z && (z.display === 'rated' || z.display === 'no-rating') && z.zoneId !== null && !res.cached) {
    try { out.product = normalizeProduct(await request(CAIC.product(z.zoneId), {...net, signal}), z, now); }
    catch (e) { out.product = {state: e.kind === 'aborted' ? 'aborted' : 'unavailable', message: e.message}; }
  }
  return out;
}
