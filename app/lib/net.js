// Network helper for static data: timeout, bounded retries for network errors, typed failures.
// Offline fallback for site data is the service worker's job ('skintrack-data' cache).
import {CONFIG} from '../config.js';

export class HttpError extends Error {
  constructor(status, url) { super(`HTTP ${status} for ${url}`); this.status = status; }
}

/** fetch() that aborts after timeoutMs and retries network errors (not HTTP errors) up to `retries` times. */
export async function fetchWithTimeout(url, {timeoutMs = CONFIG.network.timeoutMs, retries = CONFIG.network.retries, ...init} = {}) {
  for (let attempt = 0; ; attempt++) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await fetch(url, {...init, signal: ctl.signal});
      if (!res.ok) throw new HttpError(res.status, url);
      return res;
    } catch (err) {
      if (err instanceof HttpError || attempt >= retries) throw err;
      await new Promise(r => setTimeout(r, 400 * (attempt + 1)));
    } finally {
      clearTimeout(timer);
    }
  }
}

export const fetchJson = async (url, opts) => (await fetchWithTimeout(url, opts)).json();
