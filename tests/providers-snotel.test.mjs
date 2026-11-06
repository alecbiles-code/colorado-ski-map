// Run: node --test tests/   Fixtures: real NRCS AWDB responses for Berthoud Summit (335:CO:SNTL), 2026-11-06 00:09 UTC.
import test from 'node:test';
import assert from 'node:assert/strict';
import {parseSeries, change, latest, nearestStations, getStationDetail, getLatest, stationInfo} from '../app/providers/snotel.js';
import {toMs} from '../app/lib/time.js';
import {fixture, reply, hang, fakeFetch, memoryStorage, FAST} from './fixtures/fake-net.mjs';

const T = '335:CO:SNTL';
const NOW = Date.parse('2026-11-06T00:09:00Z');
const H = 3600e3;
const daily = parseSeries(fixture('awdb-daily.json'), T, -8, true);
const hourly = parseSeries(fixture('awdb-hourly.json'), T, -8, false);

test('units convert to SI and daily values are end-of-day readings in fixed PST', () => {
  const d = daily.SNWD.find(r => r.date === '2026-11-02');
  assert.equal(d.observedAt, '2026-11-03T00:00:00-08:00');
  assert.equal(d.value, 2 * 2.54);
  const h = hourly.SNWD.find(r => r.observedAt === '2026-11-03T00:00:00-08:00');
  assert.equal(h.value, d.value); // daily D equals hourly D+1 00:00
  assert.equal(daily.WTEQ.find(r => r.date === '2026-11-04').value, 0.6 * 25.4);
  assert.ok(Math.abs(hourly.TOBS[0].value - (31.6 - 32) * 5 / 9) < 1e-9);
});

test('hourly station times stay on a fixed offset across the 2026-11-01 DST change', () => {
  const ts = hourly.TOBS.map(r => toMs(r.observedAt));
  assert.ok(ts.length > 150);
  assert.ok(ts.every((t, i) => i === 0 || t - ts[i - 1] === H));
  assert.ok(hourly.TOBS.some(r => r.observedAt.startsWith('2026-11-01T01:00')) && hourly.TOBS.some(r => r.observedAt.startsWith('2026-11-01T02:00')));
});

test('suspect, implausible and missing readings are labeled, kept out of changes, never zero', () => {
  const s = hourly.SNWD.find(r => r.rawValue === -7806);
  assert.deepEqual([s.quality, s.usable], ['suspect', false]);
  const p = parseSeries([{stationTriplet: T, data: [{stationElement: {elementCode: 'SNWD', storedUnitCode: 'in'}, values: [
    {date: '2026-11-04 00:00', value: null, qcFlag: 'V'}, {date: '2026-11-04 01:00', value: 900, qcFlag: 'V'}, {date: '2026-11-04 02:00', value: 10, qcFlag: 'M'}]}]}], T, -8, false);
  assert.deepEqual(p.SNWD.map(r => [r.quality, r.value]), [['missing', null], ['implausible', 900 * 2.54], ['missing', null]]);
  assert.equal(latest(p.SNWD).quality, 'missing'); // nothing usable: the last reading is returned, labeled
  assert.equal(change(p.SNWD, H, 'SNWD').delta, null);
});

test('24 h, 7 d and 30 d changes with exact windows', () => {
  const c24 = change(hourly.SNWD, 24 * H, 'SNWD');
  assert.equal(c24.to, '2026-11-05T15:00:00-08:00');
  assert.equal(Date.parse(c24.to) - Date.parse(c24.from), 24 * H);
  const at = hourly.SNWD.find(r => r.observedAt === '2026-11-04T15:00:00-08:00');
  assert.equal(c24.delta, 2.54 - at.value); // raw readings 1 in now and at.rawValue in, 24 h earlier
  const c30 = change(daily.WTEQ, 30 * 24 * H, 'WTEQ');
  assert.equal(c30.to, '2026-11-05T00:00:00-08:00');
  assert.deepEqual([c30.delta, c30.reason], [null, 'no reading at start']); // fixture starts 2026-10-06: window not covered
  const c29 = change(daily.WTEQ, 29 * 24 * H, 'WTEQ');
  assert.ok(Math.abs(c29.delta - 0.6 * 25.4) < 1e-9); // 0.6 in on Nov 4 minus 0.0 in on Oct 6
  const start = hourly.SNWD.find(r => r.rawValue === -2 && r.quality === 'suspect');
  const series = hourly.SNWD.filter(r => toMs(r.observedAt) <= toMs(start.observedAt) + 24 * H);
  const c = change(series, 24 * H, 'SNWD');
  assert.equal(c.delta, null);
  assert.match(c.reason, /suspect/);
});

test('accumulated precipitation does not difference across the Oct 1 water-year reset', () => {
  const mk = (date, v) => ({date, observedAt: `${date}T00:00:00-08:00`, value: v, usable: true, quality: 'ok'});
  const s = [mk('2026-09-25', 900), mk('2026-10-05', 10)];
  assert.match(change(s, 10 * 24 * H, 'PREC').reason, /water-year/);
  assert.equal(change([mk('2026-10-25', 30), mk('2026-11-04', 20)], 10 * 24 * H, 'PREC').delta, null);
});

test('nearest stations: distance, elevation difference, and unknown elevation is not zero', () => {
  const f = (upstreamId, lon, lat, elevationM) => ({type: 'Feature', geometry: {type: 'Point', coordinates: [lon, lat]}, properties: {upstreamId, name: upstreamId, elevationM}});
  const near = nearestStations({lon: -105.7772, lat: 39.7983, elevationM: 3446},
    [f('335:CO:SNTL', -105.77786, 39.80364, 3444), f('602:CO:SNTL', -105.9, 39.67, 3520), f('far', -108, 37.5, 3000), f('x', -105.8, 39.8, null)]);
  assert.deepEqual(near.map(s => s.triplet), ['335:CO:SNTL', 'x', '602:CO:SNTL']);
  assert.ok(near[0].distanceM < 700);
  assert.equal(near[0].elevationDiffM, -2);
  assert.equal(near[1].elevationDiffM, null);
  const real = fixture('snotel-stations-berthoud.geojson').features[0];
  assert.deepEqual(stationInfo(real), {triplet: '335:CO:SNTL', id: '335', name: 'Berthoud Summit', network: 'SNTL', lon: real.geometry.coordinates[0],
    lat: real.geometry.coordinates[1], elevationM: real.properties.elevationM, dataTimeZone: -8, elements: Object.keys(real.properties.elements)});
});

test('station detail: normal, failure, timeout, and saved copy', async () => {
  memoryStorage();
  const routes = [[/\/stations\?/, () => reply(fixture('awdb-station-335.json'))], [/duration=DAILY/, () => reply(fixture('awdb-daily.json'))],
    [/duration=HOURLY/, () => reply(fixture('awdb-hourly.json'))]];
  const st = {triplet: T, name: 'Berthoud Summit', lon: -105.77786, lat: 39.80364, elevationM: 3444};
  const v = await getStationDetail(st, {now: NOW, net: {...FAST, fetchImpl: fakeFetch(routes)}});
  assert.equal(v.state, 'ok');
  assert.equal(v.dataTimeZone, -8);
  assert.equal(v.timeZoneSource, 'AWDB station metadata');
  assert.ok(Math.abs(v.elevationM - 11300 * 0.3048) < 1e-9);
  assert.equal(v.summary.SNWD.latest.value, 2.54);
  assert.equal(v.summary.SNWD.latest.delayed, false);
  assert.match(v.sourceUrl, /sitenum=335$/);
  const down = await getStationDetail(st, {now: NOW + H, net: {...FAST, fetchImpl: fakeFetch([[/./, () => reply({}, 500)]])}});
  assert.equal(down.state, 'stale');
  assert.equal(down.summary.SNWD.latest.delayed, false);
  const late = await getStationDetail(st, {now: NOW + 9 * H, net: {...FAST, fetchImpl: fakeFetch([[/./, () => reply({}, 500)]])}});
  assert.equal(late.summary.SNWD.latest.delayed, true);
  memoryStorage();
  const slow = await getStationDetail(st, {now: NOW, net: {baseMs: 1, timeout: 20, retries: 0, fetchImpl: fakeFetch([[/./, hang]])}});
  assert.equal(slow.state, 'unavailable');
  assert.match(slow.message, /timed out/);
});

test('batched latest readings for several stations in one request', async () => {
  const f = fakeFetch([[/duration=HOURLY/, () => reply(fixture('awdb-hourly.json'))]]);
  const r = await getLatest([{triplet: T}, {triplet: '602:CO:SNTL'}], {now: NOW, net: {...FAST, fetchImpl: f}});
  assert.equal(f.calls.length, 1);
  assert.match(decodeURIComponent(f.calls[0]), /stationTriplets=335:CO:SNTL,602:CO:SNTL/);
  assert.equal(r.byTriplet[T].depth.value, 2.54);
  assert.deepEqual(r.byTriplet['602:CO:SNTL'], {depth: null, swe: null, temp: null}); // absent from the response: unknown
  const bad = await getLatest([{triplet: T}], {now: NOW, net: {...FAST, fetchImpl: fakeFetch([])}});
  assert.equal(bad.state, 'unavailable');
});
