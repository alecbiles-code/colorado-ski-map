// Run: node --test tests/   Fixtures: real Open-Meteo best_match responses for Berthoud Pass (elevation=3446),
// 2026-11-06 00:49 UTC; openmeteo-dst.json has past_days=6 so it spans the 2026-11-01 DST change.
import test from 'node:test';
import assert from 'node:assert/strict';
import {getOpenMeteo, normalizeOpenMeteo, precipType, integrate, currentHour, forecastUrl} from '../app/providers/openmeteo.js';
import {fixture, reply, fakeFetch, memoryStorage, FAST} from './fixtures/fake-net.mjs';

const PLACE = {lon: -105.7772, lat: 39.7983, elevationM: 3446};
const NOW = Date.parse('2026-11-06T00:18:00Z');
const H = 3600e3;

test('normalizes hourly SI values, grid cell, temperature elevation and 7 complete Colorado days', async () => {
  memoryStorage();
  const f = fakeFetch([[/open-meteo/, () => reply(fixture('openmeteo.json'))]]);
  const v = await getOpenMeteo(PLACE, {now: NOW, net: {...FAST, fetchImpl: f}});
  assert.equal(v.state, 'ok');
  assert.match(f.calls[0], /models=best_match/);
  assert.match(f.calls[0], /elevation=3446/);
  assert.match(f.calls[0], /wind_speed_unit=ms/);
  assert.deepEqual([v.grid.lat, v.grid.lon], [39.80367, -105.76832]);
  assert.ok(v.grid.distanceM > 900 && v.grid.distanceM < 1000);
  assert.equal(v.grid.temperatureElevationM, 3446);
  assert.equal(v.days.length, 7);
  assert.equal(v.days[0].date, '2026-11-05');
  assert.ok(v.days.every(d => d.snowCm !== null && d.tMaxC !== null));
  assert.equal(v.next48.to, new Date(Date.parse('2026-11-06T00:00:00Z') + 48 * H).toISOString());
  assert.ok(currentHour(v, NOW));
  assert.equal(currentHour(v, NOW + 30 * 24 * H), null);
});

test('the 2026-11-01 DST day is 25 hours and complete', () => {
  const v = normalizeOpenMeteo(fixture('openmeteo-dst.json'), {...PLACE, retrievedAt: null, now: NOW});
  const d = v.days.find(x => x.date === '2026-11-01');
  assert.equal(Date.parse(d.to) - Date.parse(d.from), 25 * H);
  assert.notEqual(d.snowCm, null);
  assert.notEqual(d.tMinC, null);
});

test('a missing hour makes its windows unknown, never zero', () => {
  const raw = structuredClone(fixture('openmeteo.json'));
  const i = raw.hourly.time.findIndex(t => t * 1000 > NOW + 2 * H);
  raw.hourly.snowfall[i] = null;
  raw.hourly.temperature_2m[i] = null;
  const v = normalizeOpenMeteo(raw, {...PLACE, retrievedAt: null, now: NOW});
  assert.equal(v.next24.snowCm, null);
  assert.equal(v.next48.tMaxC, null);
  assert.notEqual(v.next24.precipMm, null);
  assert.equal(v.hours[i].snowCm, null);
});

test('integrate apportions boundary hours and refuses gaps', () => {
  const t = Date.UTC(2026, 0, 10);
  const hours = [1, 2, 3].map((x, k) => ({t: t + (k + 1) * H, s: x}));
  assert.equal(integrate(hours, t, t + 3 * H, 's'), 6);
  assert.equal(integrate(hours, t + H / 2, t + 3 * H, 's'), 5.5);
  assert.equal(integrate(hours, t, t + 4 * H, 's'), null);
});

test('precipitation type from amounts first, then code', () => {
  assert.equal(precipType({snowCm: 0.5, rainMm: 0, showersMm: 0, code: 73}), 'snow');
  assert.equal(precipType({snowCm: 0.5, rainMm: 0.2, showersMm: 0, code: 73}), 'mixed');
  assert.equal(precipType({snowCm: 0, rainMm: 1, showersMm: null, code: 66}), 'freezing rain');
  assert.equal(precipType({snowCm: 0, rainMm: 0, showersMm: 0, code: 85}), 'snow');
  assert.equal(precipType({snowCm: 0, rainMm: 0, showersMm: 0, code: 3}), 'none');
  assert.equal(precipType({snowCm: null, rainMm: null, showersMm: null, code: null}), null);
});

test('provider errors and unexpected units', async () => {
  memoryStorage();
  const f = fakeFetch([[/open-meteo/, () => reply({error: true, reason: 'Cannot initialize'}, 400)]]);
  const v = await getOpenMeteo(PLACE, {now: NOW, net: {...FAST, fetchImpl: f}});
  assert.equal(v.state, 'unavailable');
  assert.match(v.message, /Cannot initialize/);
  assert.equal(f.calls.length, 1);
  const raw = structuredClone(fixture('openmeteo.json'));
  raw.hourly_units.wind_speed_10m = 'km/h';
  assert.throws(() => normalizeOpenMeteo(raw, {...PLACE, retrievedAt: null}), /unit/);
  assert.doesNotMatch(forecastUrl({lon: -105, lat: 39}), /elevation=/);
});

test('saved copy is labeled stale and expires when its hours run out', async () => {
  memoryStorage();
  await getOpenMeteo(PLACE, {now: NOW, net: {...FAST, fetchImpl: fakeFetch([[/./, () => reply(fixture('openmeteo.json'))]])}});
  const down = fakeFetch([[/./, () => reply({}, 502)]]);
  const s = await getOpenMeteo(PLACE, {now: NOW + 2 * H, net: {...FAST, fetchImpl: down}});
  assert.equal(s.state, 'stale');
  assert.equal(s.next24.from, new Date(Math.floor((NOW + 2 * H) / H) * H).toISOString());
});
