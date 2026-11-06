// Unit conversion and display formatting: the only place units convert (ARCHITECTURE section 4.2).
// Formatters take canonical SI input and return a display string with its unit. Missing input
// (null, undefined, NaN, non-numbers) returns 'n/a'; it never becomes 0.

const KEY = 'skintrack-units';
export const NA = 'n/a';

export const finite = v => typeof v === 'number' && Number.isFinite(v);

/* ---- Pure conversions ---- */
export const M_PER_FT = 0.3048;
export const M_PER_MI = 1609.344;
export const CM_PER_IN = 2.54;
export const MS_PER_MPH = 0.44704;
export const mToFt = m => m / M_PER_FT;
export const ftToM = ft => ft * M_PER_FT;
export const mToMi = m => m / M_PER_MI;
export const miToM = mi => mi * M_PER_MI;
export const cmToIn = cm => cm / CM_PER_IN;
export const inToCm = inches => inches * CM_PER_IN;
export const mmToIn = mm => mm / (CM_PER_IN * 10);
export const inToMm = inches => inches * CM_PER_IN * 10;
export const cToF = c => c * 9 / 5 + 32;
export const fToC = f => (f - 32) * 5 / 9;
export const msToMph = ms => ms / MS_PER_MPH;
export const mphToMs = mph => mph * MS_PER_MPH;
export const msToKmh = ms => ms * 3.6;
export const kmhToMs = kmh => kmh / 3.6;

/* ---- Preference ---- */
let memory = null; // used when storage is blocked, so a choice still holds for this session

/** Display unit system: 'imperial' (default) or 'metric'. Storage errors are tolerated. */
export function getUnits() {
  try {
    const v = globalThis.localStorage?.getItem(KEY);
    if (v === 'metric' || v === 'imperial') return v;
  } catch { /* blocked storage: fall through */ }
  return memory || 'imperial';
}

/** Persist the unit system and announce it with the window event 'skintrack:units'. */
export function setUnits(u) {
  const v = u === 'metric' ? 'metric' : 'imperial';
  memory = v;
  try { globalThis.localStorage?.setItem(KEY, v); } catch { /* blocked or full: keep the in-memory choice */ }
  const w = globalThis.window;
  if (w?.dispatchEvent && typeof CustomEvent === 'function') w.dispatchEvent(new CustomEvent('skintrack:units', {detail: {units: v}}));
  return v;
}

/* ---- Formatting ---- */
const nfCache = new Map();
/** Number with thousands separators and a fixed number of decimals; -0 prints as 0. */
export function num(v, digits = 0) {
  if (!nfCache.has(digits)) nfCache.set(digits, new Intl.NumberFormat('en-US', {minimumFractionDigits: digits, maximumFractionDigits: digits}));
  const r = Number(v.toFixed(digits));
  return nfCache.get(digits).format(r === 0 ? 0 : r);
}
const sign = (v, signed) => (signed && Number(v) > 0 ? '+' : '');
/**
 * Shared wrapper: missing guard, unit choice, optional explicit + sign for changes, and `bare` (number only,
 * for table cells whose header carries the unit from unitLabel).
 */
function make(convert) {
  return (v, {units = getUnits(), signed = false, bare = false} = {}) => {
    if (!finite(v)) return NA;
    const [x, digits, suffix] = convert(v, units === 'metric');
    const s = num(x, digits);
    return `${sign(s.replace(/,/g, ''), signed)}${s}${bare ? '' : suffix}`;
  };
}
const smallDigits = (x, limit, small, big) => (Math.abs(x) < limit ? small : big);

/** Elevation in metres, whole feet or metres. */
export const fmtElevation = make((m, metric) => (metric ? [m, 0, ' m'] : [mToFt(m), 0, ' ft']));
/** Distance in metres: feet or metres under about 0.1 mi or 1 km, otherwise mi or km. */
export const fmtDistance = make((m, metric) => {
  if (metric) return Math.abs(m) < 1000 ? [Math.round(m / 10) * 10, 0, ' m'] : [m / 1000, smallDigits(m / 1000, 10, 1, 0), ' km'];
  const mi = mToMi(m);
  return Math.abs(mi) < 0.1 ? [Math.round(mToFt(m) / 10) * 10, 0, ' ft'] : [mi, smallDigits(mi, 10, 1, 0), ' mi'];
});
/** Temperature in degrees Celsius. */
export const fmtTemp = make((c, metric) => (metric ? [c, 0, '°C'] : [cToF(c), 0, '°F']));
/** Speed in m/s. */
export const fmtSpeed = make((ms, metric) => (metric ? [msToKmh(ms), 0, ' km/h'] : [msToMph(ms), 0, ' mph']));
/** Snow depth in cm, whole inches or centimetres (sensors resolve about 1 in). */
export const fmtSnowDepth = make((cm, metric) => (metric ? [cm, 0, ' cm'] : [cmToIn(cm), 0, ' in']));
/** Water (SWE or precipitation) in mm. */
export const fmtWater = make((mm, metric) => {
  if (metric) return [mm, smallDigits(mm, 10, 1, 0), ' mm'];
  const i = mmToIn(mm);
  return [i, smallDigits(i, 1, 2, 1), ' in'];
});
/** Snowfall (new snow, forecast or estimated) in cm. */
export const fmtSnowfall = make((cm, metric) => {
  const x = metric ? cm : cmToIn(cm);
  return [x, smallDigits(x, 10, 1, 0), metric ? ' cm' : ' in'];
});
/** Angle in degrees (slope, aspect), unit independent. */
export const fmtAngle = make(deg => [deg, 0, '°']);
/** Elevation difference with an explicit sign, for comparisons such as station vs point. */
export const fmtElevationDelta = (m, opts = {}) => fmtElevation(m, {...opts, signed: true});

const LABELS = {elevation: ['ft', 'm'], temp: ['\u00b0F', '\u00b0C'], speed: ['mph', 'km/h'], snowDepth: ['in', 'cm'], water: ['in', 'mm'], snowfall: ['in', 'cm']};
/** Unit label for a quantity kind in the current (or given) unit system, e.g. unitLabel('speed') -> 'mph'. */
export const unitLabel = (kind, units = getUnits()) => LABELS[kind]?.[units === 'metric' ? 1 : 0] ?? '';

const POINTS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
/** 16-point compass name for a direction in degrees clockwise from north (the direction wind comes from). */
export function compass(deg) {
  if (!finite(deg)) return NA;
  return POINTS[Math.round((((deg % 360) + 360) % 360) / 22.5) % 16];
}
