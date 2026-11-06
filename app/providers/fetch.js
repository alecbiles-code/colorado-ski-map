// Shared network helper for the condition providers: a timeout on every attempt (body included), bounded
// retries with backoff, the caller's AbortSignal, and a last-good copy per provider and place in localStorage.
// The retry policy is ported from the weather app core.js (commit 914f4aa). Errors carry `kind`
// ('aborted' | 'timeout' | 'network' | 'http' | 'parse') and a short message fit for the page.

export const DEFAULTS = Object.freeze({timeout: 15000, retries: 2, baseMs: 1000});
/** NRCS AWDB answers in 4 s to over 100 s on the same request (weather app notes); give it longer. */
export const SLOW_TIMEOUT = 30000;
const STORE = 'skintrack-lastgood-';
const KEEP_ENTRIES = 12; // places per provider kept on the device

/** HTTP statuses worth another try: timeouts, rate limits and server errors. */
export const retryableStatus = status => status === 408 || status === 429 || status >= 500;

const fail = (kind, message, extra = {}) => Object.assign(new Error(message), {kind, retryable: kind !== 'aborted', ...extra});

/** Resolve after ms, or reject at once when the signal aborts. */
function wait(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(fail('aborted', 'Cancelled')); return; }
    const t = setTimeout(() => { signal?.removeEventListener('abort', stop); resolve(); }, ms);
    function stop() { clearTimeout(t); reject(fail('aborted', 'Cancelled')); }
    signal?.addEventListener('abort', stop, {once: true});
  });
}

async function attempt(url, {timeout, signal, headers, fetchImpl, as}) {
  if (signal?.aborted) throw fail('aborted', 'Cancelled');
  const ctrl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; ctrl.abort(); }, timeout);
  const onAbort = () => ctrl.abort();
  signal?.addEventListener('abort', onAbort, {once: true});
  try {
    const r = await fetchImpl(url, {headers, signal: ctrl.signal, credentials: 'omit'});
    if (!r.ok) {
      const body = await r.json().catch(() => null);
      const why = body?.reason || body?.detail || body?.title;
      throw fail('http', why ? `${why} (HTTP ${r.status})` : `HTTP ${r.status}`, {status: r.status, retryable: retryableStatus(r.status)});
    }
    if (as === 'text') return await r.text();
    const body = await r.json().catch(() => { throw fail('parse', 'Unreadable response'); });
    if (body?.error === true) throw fail('http', body.reason || 'Provider error', {retryable: false}); // Open-Meteo style
    return body;
  } catch (e) {
    if (e?.kind) throw e;
    if (signal?.aborted) throw fail('aborted', 'Cancelled');
    if (timedOut || e?.name === 'AbortError') throw fail('timeout', `Request timed out after ${Math.round(timeout / 1000)} s`);
    throw fail('network', 'Network unavailable'); // fetch's own failure: offline, DNS, CORS
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

/**
 * GET JSON (or text) with a per-attempt timeout and up to `retries` retries, waiting baseMs, then 3 x baseMs.
 * Rejects with a kinded error; an aborted signal rejects at once and is never retried.
 */
export async function request(url, opts = {}) {
  const {timeout = DEFAULTS.timeout, retries = DEFAULTS.retries, baseMs = DEFAULTS.baseMs, signal, headers = {Accept: 'application/json'},
    fetchImpl = (...a) => globalThis.fetch(...a), as = 'json', sleep = wait} = opts;
  for (let n = 0; ; n++) {
    try { return await attempt(url, {timeout, signal, headers, fetchImpl, as}); }
    catch (e) {
      if (e.kind === 'aborted' || n >= retries || e.retryable === false) throw e;
      await sleep(baseMs * 3 ** n, signal);
    }
  }
}

/* ---- Last-good copies ---- */
/** Place key with about 100 m resolution. */
export const placeKey = (lon, lat) => `${Number(lon).toFixed(3)},${Number(lat).toFixed(3)}`;

function readBucket(provider) {
  try { const raw = globalThis.localStorage?.getItem(STORE + provider); const b = raw ? JSON.parse(raw) : null; return b && typeof b === 'object' ? b : {}; }
  catch { return {}; }
}
/** Save a normalized value for (provider, key); keeps the most recent KEEP_ENTRIES places. Storage errors are ignored. */
export function saveLastGood(provider, key, value, now = Date.now()) {
  try {
    const b = readBucket(provider);
    b[key] = {at: now, v: value};
    const keep = Object.entries(b).sort((x, y) => y[1].at - x[1].at).slice(0, KEEP_ENTRIES);
    globalThis.localStorage?.setItem(STORE + provider, JSON.stringify(Object.fromEntries(keep)));
  } catch { /* storage full or blocked: keep working without a copy */ }
}
/** The saved copy {at, v} if younger than maxAgeMs, else null. */
export function readLastGood(provider, key, maxAgeMs, now = Date.now()) {
  const c = readBucket(provider)[key];
  return c && Number.isFinite(c.at) && now - c.at <= maxAgeMs && c.v ? c : null;
}

/**
 * Run load(); on success save the value and return {value, cached: false}. On failure return the last good
 * copy {value, cached: true, savedAt, error} when one is young enough, else {value: null, error}.
 * Cancellation returns {aborted: true}. Never throws.
 */
export async function withLastGood(provider, key, load, {maxAgeMs, now = Date.now()} = {}) {
  try {
    const value = await load();
    saveLastGood(provider, key, value, now);
    return {value, cached: false, savedAt: now, error: null};
  } catch (e) {
    if (e?.kind === 'aborted') return {value: null, aborted: true, error: e};
    const c = readLastGood(provider, key, maxAgeMs, now);
    return c ? {value: c.v, cached: true, savedAt: c.at, error: e} : {value: null, cached: false, error: e};
  }
}
