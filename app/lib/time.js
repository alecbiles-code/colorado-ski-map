// Time parsing and Colorado display. Instants are ISO 8601 strings with an offset or Z (or epoch ms);
// display is America/Denver with DST. A date-time string without an offset is ambiguous and is rejected
// (returns null / 'n/a'); a provider that sends local clock times must convert with withOffset() first.
// Calendar helpers (zonedEpoch, dayBounds) are ported from the weather app core.js at commit 914f4aa.

import {NA, finite} from './units.js';

export const TZ = 'America/Denver';
export const HOUR = 3600000;
export const DAY = 24 * HOUR;

const OFFSET_RE = /(?:Z|[+-]\d\d:?\d\d)$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Epoch ms for an instant (ISO string with offset or Z, epoch ms, or Date), else null. */
export function toMs(v) {
  if (v instanceof Date) return finite(v.getTime()) ? v.getTime() : null;
  if (finite(v)) return v;
  if (typeof v !== 'string' || !OFFSET_RE.test(v.trim())) return null;
  const n = Date.parse(v.trim());
  return finite(n) ? n : null;
}

/** ISO string with Z for epoch ms, or null. */
export const iso = ms => (finite(ms) ? new Date(ms).toISOString() : null);

/**
 * Attach a fixed UTC offset (hours, e.g. -7 for Mountain Standard Time) to a local clock string such as
 * '2026-11-05 13:00'. For sources that report in fixed standard time all year (NRCS SNOTEL), so DST is never
 * applied to them. Returns an ISO string with offset, or null.
 */
export function withOffset(local, offsetHours) {
  const m = typeof local === 'string' && local.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})(?::(\d{2}))?$/);
  if (!m || !finite(offsetHours)) return null;
  const sgn = offsetHours < 0 ? '-' : '+', a = Math.abs(offsetHours);
  const hh = String(Math.floor(a)).padStart(2, '0'), mm = String(Math.round((a % 1) * 60)).padStart(2, '0');
  const s = `${m[1]}T${m[2]}:${m[3] || '00'}${sgn}${hh}:${mm}`;
  return toMs(s) === null ? null : s;
}

/* ---- Display in Colorado time ---- */
const fmts = new Map();
function formatter(key, opts) {
  if (!fmts.has(key)) fmts.set(key, new Intl.DateTimeFormat('en-US', {timeZone: TZ, ...opts}));
  return fmts.get(key);
}
/** Calendar date string 'YYYY-MM-DD' formatted as a day, without any time zone shift. */
function calendarDay(s) {
  const d = new Date(`${s}T12:00:00Z`);
  return finite(d.getTime()) && d.toISOString().slice(0, 10) === s
    ? new Intl.DateTimeFormat('en-US', {timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric'}).format(d) : NA;
}

/** 'Thu, Nov 5, 3:04 PM MST' in Colorado time. */
export function fmtDateTime(v) {
  const ms = toMs(v);
  return ms === null ? NA : formatter('dt', {weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short'}).format(ms);
}
/** '3:04 PM' in Colorado time. */
export function fmtTime(v) {
  const ms = toMs(v);
  return ms === null ? NA : formatter('t', {hour: 'numeric', minute: '2-digit'}).format(ms);
}
/** 'Thu, Nov 5' in Colorado time. A bare 'YYYY-MM-DD' is a calendar date and is shown as is. */
export function fmtDay(v) {
  if (typeof v === 'string' && DATE_RE.test(v)) return calendarDay(v);
  const ms = toMs(v);
  return ms === null ? NA : formatter('d', {weekday: 'short', month: 'short', day: 'numeric'}).format(ms);
}
/** '3 PM' style hour label in Colorado time, for hourly tables. */
export function fmtHour(v) {
  const ms = toMs(v);
  return ms === null ? NA : formatter('h', {hour: 'numeric'}).format(ms);
}

/** 'just now', '5 min ago', '3 h ago', '2 days ago', or 'in 3 h' for future times. */
export function ageText(v, now = Date.now()) {
  const ms = toMs(v), n = toMs(now);
  if (ms === null || n === null) return NA;
  const d = n - ms, a = Math.abs(d);
  let s;
  if (a < 60000) return 'just now';
  if (a < HOUR) s = `${Math.round(a / 60000)} min`;
  else if (a < 2 * DAY) s = `${Math.round(a / HOUR)} h`;
  else s = `${Math.round(a / DAY)} days`;
  return d >= 0 ? `${s} ago` : `in ${s}`;
}

/** 'current' | 'expired' | 'not-yet-valid' | 'unknown' for a validity window [validFrom, validTo). */
export function validityState({validFrom, validTo} = {}, now = Date.now()) {
  const a = toMs(validFrom), b = toMs(validTo), n = toMs(now);
  if (a === null || b === null || n === null || b <= a) return 'unknown';
  if (n < a) return 'not-yet-valid';
  if (n >= b) return 'expired';
  return 'current';
}

/* ---- DST-aware Colorado calendar (ported from weather core.js) ---- */
const partsFmt = new Intl.DateTimeFormat('en-CA', {timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'});
/** Colorado wall-clock parts for an instant. */
export function localParts(ms) {
  return Object.fromEntries(partsFmt.formatToParts(new Date(ms)).filter(p => p.type !== 'literal').map(p => [p.type, p.value]));
}
/** Colorado calendar date 'YYYY-MM-DD' for an instant. */
export function localDate(ms = Date.now()) { const p = localParts(ms); return `${p.year}-${p.month}-${p.day}`; }
/** Calendar date shifted by n days. */
export function shiftDate(date, n) { const d = new Date(`${date}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
/** Epoch ms of a Colorado wall-clock time on a date (DST resolved by iteration). */
export function zonedEpoch(date, time = '00:00') {
  const [y, m, d] = date.split('-').map(Number), [hh, mm, ss = 0] = time.split(':').map(Number);
  const target = Date.UTC(y, m - 1, d, hh, mm, ss);
  let estimate = target;
  for (let i = 0; i < 4; i++) {
    const p = localParts(estimate);
    const diff = target - Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
    if (!diff) break;
    estimate += diff;
  }
  return estimate;
}
/** Colorado calendar day as [start, end) epoch ms; 23 or 25 hours on DST change days. */
export function dayBounds(date) { return [zonedEpoch(date), zonedEpoch(shiftDate(date, 1))]; }
