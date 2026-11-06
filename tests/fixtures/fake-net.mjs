// Test helpers: recorded fixtures, a routed fake fetch, and an in-memory localStorage.
import {readFileSync} from 'node:fs';

export const fixture = name => JSON.parse(readFileSync(new URL(`./${name}`, import.meta.url), 'utf8'));

/** Response-like object. */
export const reply = (body, status = 200) => ({ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body)});
/** Never answers; rejects with AbortError when the request's signal aborts (a timeout or a cancel). */
export const hang = (url, init) => new Promise((_, reject) => {
  init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), {name: 'AbortError'})));
});
/** Fake fetch: routes is [[RegExp, (url, init) => response], ...]; records every URL in .calls. */
export function fakeFetch(routes) {
  const f = async (url, init) => {
    f.calls.push(url);
    for (const [re, h] of routes) if (re.test(url)) return h(url, init);
    throw new TypeError(`Failed to fetch ${url}`);
  };
  f.calls = [];
  return f;
}
/** Fresh in-memory localStorage on globalThis. */
export function memoryStorage() {
  const m = new Map();
  globalThis.localStorage = {getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k)};
  return m;
}
/** Fast retries for tests. */
export const FAST = {baseMs: 1, timeout: 200};
