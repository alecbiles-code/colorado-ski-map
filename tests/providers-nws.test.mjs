// Run: node --test tests/   Fixtures: real api.weather.gov responses for Berthoud Pass, 2026-11-06 00:07 UTC, trimmed.
import test from 'node:test';
import assert from 'node:assert/strict';
import {getNws, accumulate, range, valueAt, interval, durationMs, gridSeries} from '../app/providers/nws.js';
import {fixture, reply, hang, fakeFetch, memoryStorage, FAST} from './fixtures/fake-net.mjs';

const PLACE = {lon: -105.7772, lat: 39.7983, elevationM: 3446};
const NOW = Date.parse('2026-11-06T00:08:00Z');
const points = fixture('nws-points.json');
const routes = () => [
  [/\/points\//, () => reply(points)],
  [/\/forecast$/, () => reply(fixture('nws-forecast.json'))],
  [/\/gridpoints\/BOU\/36,66$/, () => reply(fixture('nws-grid.json'))],
  [/\/alerts\/active/, () => reply(fixture('nws-alerts-empty.json'))]
];

test('follows the URLs from /points and normalizes to SI with the grid elevation', async () => {
  memoryStorage();
  const f = fakeFetch(routes());
  const v = await getNws(PLACE, {now: NOW, net: {...FAST, fetchImpl: f}});
  assert.equal(v.state, 'ok');
  assert.ok(f.calls.includes(points.properties.forecast) && f.calls.includes(points.properties.forecastGridData));
  assert.equal(v.office, 'BOU');
  assert.ok(Math.abs(v.grid.elevationM - 3581.0952) < 1e-6);
  assert.equal(v.point.elevationM, 3446);
  assert.equal(v.issuedAt, '2026-11-05T18:47:50+00:00');
  assert.equal(v.periods.length, 6);
  assert.ok(Math.abs(v.periods[0].tempC - (31 - 32) * 5 / 9) < 1e-9); // 31 F
  assert.ok(Math.abs(v.series.windSpeed[0].v - 11.112 / 3.6) < 1e-9);
  assert.ok(Math.abs(valueAt(v.series.temperature, Date.parse('2026-11-05T12:30:00Z')) + 8.3333) < 1e-3);
  assert.deepEqual([v.alerts.state, v.alerts.items.length], ['ok', 0]);
  assert.match(v.sourceUrl, /^https:\/\/forecast\.weather\.gov\/MapClick\.php\?lat=39\.7983&lon=-105\.7772$/);
});

test('a point outside NWS coverage is outside-coverage, not an error', async () => {
  memoryStorage();
  const f = fakeFetch([[/\/points\//, () => reply(fixture('nws-points-404.json'), 404)], [/alerts/, () => reply(fixture('nws-alerts-empty.json'))]]);
  const v = await getNws({lon: -140, lat: 30}, {now: NOW, net: {...FAST, fetchImpl: f}});
  assert.equal(v.state, 'outside-coverage');
});

test('failure gives unavailable, then a labeled saved copy after one success', async () => {
  memoryStorage();
  const down = fakeFetch([[/./, () => reply({}, 503)]]);
  const a = await getNws(PLACE, {now: NOW, net: {...FAST, fetchImpl: down}});
  assert.equal(a.state, 'unavailable');
  assert.equal(a.alerts.state, 'unavailable');
  await getNws(PLACE, {now: NOW, net: {...FAST, fetchImpl: fakeFetch(routes())}});
  const b = await getNws(PLACE, {now: NOW + 3600e3, net: {...FAST, fetchImpl: down}});
  assert.equal(b.state, 'stale');
  assert.equal(b.cached, true);
  assert.match(b.message, /saved on this device 1 h ago/);
  assert.equal(b.alerts.state, 'unavailable'); // alerts are never served from a saved copy
});

test('timeout and cancel', async () => {
  memoryStorage();
  const v = await getNws(PLACE, {now: NOW, net: {baseMs: 1, timeout: 20, retries: 0, fetchImpl: fakeFetch([[/./, hang]])}});
  assert.equal(v.state, 'unavailable');
  assert.match(v.message, /timed out/);
  const c = new AbortController();
  c.abort();
  assert.equal((await getNws(PLACE, {now: NOW, signal: c.signal, net: {...FAST, fetchImpl: fakeFetch(routes())}})).state, 'aborted');
});

test('expired and stale forecasts are flagged', async () => {
  memoryStorage();
  const late = await getNws(PLACE, {now: Date.parse('2026-11-14T00:00:00Z'), net: {...FAST, fetchImpl: fakeFetch(routes())}});
  assert.equal(late.state, 'expired');
  memoryStorage();
  const old = await getNws(PLACE, {now: Date.parse('2026-11-06T08:00:00Z'), net: {...FAST, fetchImpl: fakeFetch(routes())}});
  assert.equal(old.state, 'stale'); // updateTime 18:47 UTC is more than 12 h before
});

test('one failed part does not blank the rest', async () => {
  memoryStorage();
  const r = routes();
  r[1] = [/\/forecast$/, () => reply({}, 500)];
  const v = await getNws(PLACE, {now: NOW, net: {...FAST, fetchImpl: fakeFetch(r)}});
  assert.equal(v.state, 'ok');
  assert.deepEqual(v.periods, []);
  assert.equal(v.parts.forecast, 'unavailable');
  assert.ok(v.series.temperature.length > 0);
});

test('interval math: durations, accumulation and missing values', () => {
  assert.equal(durationMs('PT6H'), 6 * 3600e3);
  assert.equal(durationMs('P1DT3H'), 27 * 3600e3);
  assert.equal(durationMs('P'), null);
  assert.equal(interval('2026-11-05T12:00:00+00:00/PT1H')[1], Date.parse('2026-11-05T13:00:00Z'));
  const t = Date.parse('2026-11-05T12:00:00Z'), H = 3600e3;
  const s = [{from: t, to: t + 6 * H, v: 6}, {from: t + 6 * H, to: t + 12 * H, v: 0}];
  assert.equal(accumulate(s, t, t + 12 * H), 6);
  assert.equal(accumulate(s, t + 3 * H, t + 9 * H), 3); // apportioned
  assert.equal(accumulate(s, t, t + 18 * H), null); // not covered
  assert.equal(accumulate([{from: t, to: t + 6 * H, v: null}], t, t + 6 * H), null);
  assert.deepEqual(range(s, t, t + 12 * H), {min: 0, max: 6});
  assert.deepEqual(range([{from: t, to: t + H, v: null}], t, t + H), {min: null, max: null});
  assert.throws(() => gridSeries({uom: 'wmoUnit:furlong', values: []}));
  assert.equal(gridSeries({uom: 'wmoUnit:mm', values: [{validTime: '2026-11-05T12:00:00+00:00/PT6H', value: 25}]}, 0.1)[0].v, 2.5);
});
