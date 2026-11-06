// Run: node --test tests/
import test from 'node:test';
import assert from 'node:assert/strict';
import {request, withLastGood, saveLastGood, readLastGood} from '../app/providers/fetch.js';
import {reply, hang, fakeFetch, memoryStorage, FAST} from './fixtures/fake-net.mjs';

test('retries server errors with backoff, then succeeds', async () => {
  let n = 0;
  const f = fakeFetch([[/x/, () => (++n < 3 ? reply({}, 503) : reply({ok: 1}))]]);
  assert.deepEqual(await request('https://x', {...FAST, fetchImpl: f}), {ok: 1});
  assert.equal(f.calls.length, 3);
});

test('client errors are not retried and carry the provider reason', async () => {
  const f = fakeFetch([[/x/, () => reply({reason: 'Latitude must be in range'}, 400)]]);
  await assert.rejects(request('https://x', {...FAST, fetchImpl: f}), e => e.kind === 'http' && e.status === 400 && /Latitude/.test(e.message));
  assert.equal(f.calls.length, 1);
});

test('timeouts are reported as timeouts after bounded retries', async () => {
  const f = fakeFetch([[/x/, hang]]);
  await assert.rejects(request('https://x', {baseMs: 1, timeout: 30, retries: 1, fetchImpl: f}), e => e.kind === 'timeout');
  assert.equal(f.calls.length, 2);
});

test('caller abort cancels at once, also during backoff, and is not retried', async () => {
  const c = new AbortController();
  const f = fakeFetch([[/x/, hang]]);
  const p = request('https://x', {timeout: 5000, fetchImpl: f, signal: c.signal});
  setTimeout(() => c.abort(), 20);
  await assert.rejects(p, e => e.kind === 'aborted');
  assert.equal(f.calls.length, 1);
  const c2 = new AbortController();
  const g = fakeFetch([[/x/, () => reply({}, 500)]]);
  const q = request('https://x', {baseMs: 10000, fetchImpl: g, signal: c2.signal});
  setTimeout(() => c2.abort(), 20);
  await assert.rejects(q, e => e.kind === 'aborted');
});

test('network failure maps to a short message', async () => {
  await assert.rejects(request('https://nowhere', {...FAST, retries: 0, fetchImpl: fakeFetch([])}), e => e.kind === 'network');
});

test('last-good copy is used on failure, with its age, and storage is bounded', async () => {
  memoryStorage();
  const t = 1_000_000_000_000;
  const ok = await withLastGood('p', 'k', async () => ({v: 1}), {maxAgeMs: 1000, now: t});
  assert.deepEqual([ok.value, ok.cached], [{v: 1}, false]);
  const bad = await withLastGood('p', 'k', async () => { throw Object.assign(new Error('down'), {kind: 'network'}); }, {maxAgeMs: 1000, now: t + 500});
  assert.deepEqual([bad.value, bad.cached, bad.savedAt], [{v: 1}, true, t]);
  const old = await withLastGood('p', 'k', async () => { throw new Error('down'); }, {maxAgeMs: 1000, now: t + 5000});
  assert.equal(old.value, null);
  for (let i = 0; i < 20; i++) saveLastGood('p', `k${i}`, {i}, t + i);
  assert.equal(readLastGood('p', 'k0', 1e9, t + 30), null);
  assert.deepEqual(readLastGood('p', 'k19', 1e9, t + 30).v, {i: 19});
  globalThis.localStorage = {getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); }};
  const blocked = await withLastGood('p', 'k', async () => ({v: 2}), {maxAgeMs: 1000, now: t});
  assert.deepEqual(blocked.value, {v: 2});
  delete globalThis.localStorage;
});
