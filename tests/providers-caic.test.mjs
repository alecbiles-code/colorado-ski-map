// Run: node --test tests/   Fixtures: real avalanche.org CAIC map layer (3 of 10 zones kept) and product for zone 2745,
// 2026-11-06 00:10 UTC. Valid 2026-11-05T23:30Z to 2026-11-06T23:30Z.
import test from 'node:test';
import assert from 'node:assert/strict';
import {getCaic, resolvePlace, normalizeZone, normalizeProduct, officialLink, plainText} from '../app/providers/caic.js';
import {fixture, reply, fakeFetch, memoryStorage, FAST} from './fixtures/fake-net.mjs';

const BERTHOUD = {lon: -105.7772, lat: 39.7983};
const NOW = Date.parse('2026-11-06T00:10:00Z');
const layer = fixture('caic-maplayer.json');
const routes = () => [[/map-layer\/CAIC$/, () => reply(fixture('caic-maplayer.json'))], [/zone_id=2745$/, () => reply(fixture('caic-product-2745.json'))]];
const run = (place, now, f, extra = {}) => getCaic(place, {enabled: true, now, net: {...FAST, fetchImpl: f}, ...extra});

test('switched off: no request, and a location-aware official link', async () => {
  const f = fakeFetch([]);
  const v = await getCaic(BERTHOUD, {enabled: false, net: {fetchImpl: f}});
  assert.equal(v.state, 'disabled');
  assert.equal(f.calls.length, 0);
  assert.equal(v.officialUrl, 'https://avalanche.state.co.us/?lat=39.7983&lng=-105.7772');
  assert.equal(officialLink({}), 'https://avalanche.state.co.us/');
});

test('current zone gives its rating with its own times; the product is fetched only when its switch is on', async () => {
  memoryStorage();
  const off = fakeFetch(routes());
  const a = await run(BERTHOUD, NOW, off);
  assert.equal(a.product, undefined);
  assert.ok(off.calls.every(u => !/\/product\?/.test(u)));
  const v = await run(BERTHOUD, NOW, fakeFetch(routes()), {detail: true});
  assert.equal(v.state, 'rated');
  const z = v.point.zones[0];
  assert.deepEqual([z.zoneId, z.dangerLevel, z.validFrom, z.validTo], [2745, 1, '2026-11-05T23:30:00.000Z', '2026-11-06T23:30:00.000Z']);
  assert.equal(v.product.state, 'ok');
  assert.deepEqual(v.product.danger[0], {day: 'current', upper: 1, middle: 1, lower: 1});
  assert.ok(v.product.areaNames.includes('Front Range'));
  assert.doesNotMatch(v.product.bottomLine, /<p>/);
});

test('expired and not-yet-valid zones never show a rating', async () => {
  memoryStorage();
  const late = await run(BERTHOUD, Date.parse('2026-11-07T00:00:00Z'), fakeFetch(routes()), {detail: true});
  assert.equal(late.state, 'expired');
  assert.equal(late.point.zones[0].dangerLevel, null);
  assert.equal(late.product, undefined);
  const early = normalizeZone(layer.features[0], Date.parse('2026-11-05T12:00:00Z'));
  assert.deepEqual([early.display, early.dangerLevel], ['not-yet-valid', null]);
  const noTimes = normalizeZone({...layer.features[0], properties: {...layer.features[0].properties, end_date: null}}, NOW);
  assert.deepEqual([noTimes.display, noTimes.dangerLevel], ['unknown-validity', null]);
});

test('off-season or missing level is no-rating, not low', () => {
  const p = layer.features[0].properties;
  assert.equal(normalizeZone({...layer.features[0], properties: {...p, off_season: true}}, NOW).display, 'no-rating');
  assert.equal(normalizeZone({...layer.features[0], properties: {...p, danger_level: -1}}, NOW).dangerLevel, null);
});

test('outside coverage, boundary overlap, no product', async () => {
  memoryStorage();
  assert.equal((await run({lon: -100, lat: 39}, NOW, fakeFetch(routes()))).state, 'outside-coverage');
  const dup = structuredClone(layer);
  dup.features.push({...structuredClone(dup.features.find(f => f.id === 2745)), id: 9999});
  const r = resolvePlace(dup.features, BERTHOUD, NOW);
  assert.equal(r.point.state, 'boundary-overlap');
  assert.equal(r.point.zones.length, 2);
  memoryStorage();
  const empty = await run(BERTHOUD, NOW, fakeFetch([[/map-layer/, () => reply({type: 'FeatureCollection', features: []})]]));
  assert.equal(empty.state, 'no-product');
});

test('a route crossing zones exposes each zone with its own rating, times and link', () => {
  const line = {type: 'LineString', coordinates: [[-105.7772, 39.7983], [-105.8913, 39.7742], [-105.879, 39.6634], [-106.0, 39.5]]};
  const r = resolvePlace(layer.features, {...BERTHOUD, line}, NOW);
  assert.deepEqual(r.route.zones.map(z => z.zoneId), [2745, 2755]);
  assert.ok(r.route.zones.every(z => z.display === 'rated' && z.validTo === '2026-11-06T23:30:00.000Z'));
  assert.notEqual(r.route.zones[0].officialUrl, r.route.zones[1].officialUrl);
  assert.equal(r.route.outside, 0);
  const off = resolvePlace(layer.features, {...BERTHOUD, line: {type: 'LineString', coordinates: [[-105.7772, 39.7983], [-104.5, 39.7]]}}, NOW);
  assert.ok(off.route.outside > 0);
});

test('failed feed is unavailable, never a rating; a saved feed keeps each zone expiry', async () => {
  memoryStorage();
  const down = fakeFetch([[/./, () => reply({}, 503)]]);
  const a = await run(BERTHOUD, NOW, down);
  assert.equal(a.state, 'unavailable');
  assert.equal(a.point, undefined);
  await run(BERTHOUD, NOW, fakeFetch(routes()));
  const b = await run(BERTHOUD, NOW + 3600e3, down);
  assert.deepEqual([b.state, b.cached], ['rated', true]);
  assert.equal(b.product, undefined); // no detail fetch from a saved feed
  const c = await run(BERTHOUD, Date.parse('2026-11-07T01:00:00Z'), down);
  assert.equal(c.state, 'expired');
});

test('product from another publication or zone is not merged', () => {
  const z = normalizeZone(layer.features.find(f => f.id === 2745), NOW);
  const p = fixture('caic-product-2745.json');
  assert.equal(normalizeProduct({...p, published_time: '2026-11-04T23:30:00+00:00'}, z).state, 'mismatch');
  assert.equal(normalizeProduct({...p, forecast_zone: [{id: 1}]}, z).state, 'mismatch');
  assert.equal(normalizeProduct({}, z).state, 'no-product');
  assert.equal(normalizeProduct(p, z, Date.parse('2026-11-07T00:00:00Z')).state, 'expired');
  assert.equal(normalizeProduct(p, z, NOW).state, 'ok');
  assert.equal(plainText('<p>A &amp; B</p><p>C</p>'), 'A & B\nC');
});
