// Run: node --test tests/
import test from 'node:test';
import assert from 'node:assert/strict';
import {getUnits, setUnits, fmtElevation, fmtDistance, fmtTemp, fmtSpeed, fmtSnowDepth, fmtWater, fmtSnowfall, fmtAngle,
  fmtElevationDelta, compass, mToFt, cToF, msToMph, cmToIn, mmToIn, ftToM, fToC} from '../app/lib/units.js';

const I = {units: 'imperial'}, M = {units: 'metric'};

test('missing input is n/a in every formatter, never 0', () => {
  for (const f of [fmtElevation, fmtDistance, fmtTemp, fmtSpeed, fmtSnowDepth, fmtWater, fmtSnowfall, fmtAngle]) {
    for (const v of [null, undefined, NaN, '', '5', Infinity]) {
      assert.equal(f(v, I), 'n/a');
      assert.equal(f(v, M), 'n/a');
    }
  }
  assert.equal(compass(null), 'n/a');
});

test('zero stays zero (a valid reading, distinct from missing)', () => {
  assert.equal(fmtSnowDepth(0, I), '0 in');
  assert.equal(fmtTemp(0, M), '0°C');
  assert.equal(fmtTemp(-0.2, M), '0°C');
});

test('imperial and metric formatting', () => {
  assert.equal(fmtElevation(3446, I), '11,306 ft');
  assert.equal(fmtElevation(3446, M), '3,446 m');
  assert.equal(fmtDistance(30, I), '100 ft');
  assert.equal(fmtDistance(2414, I), '1.5 mi');
  assert.equal(fmtDistance(32187, I), '20 mi');
  assert.equal(fmtDistance(850, M), '850 m');
  assert.equal(fmtDistance(2414, M), '2.4 km');
  assert.equal(fmtTemp(-10, I), '14°F');
  assert.equal(fmtSpeed(10, I), '22 mph');
  assert.equal(fmtSpeed(10, M), '36 km/h');
  assert.equal(fmtSnowDepth(106.68, I), '42 in');
  assert.equal(fmtWater(5.08, I), '0.20 in');
  assert.equal(fmtWater(304.8, I), '12.0 in');
  assert.equal(fmtWater(4.2, M), '4.2 mm');
  assert.equal(fmtSnowfall(2.54, I), '1.0 in');
  assert.equal(fmtSnowfall(30.48, I), '12 in');
  assert.equal(fmtAngle(34.6), '35°');
  assert.equal(fmtElevationDelta(-150, I), '-492 ft');
  assert.equal(fmtElevationDelta(150, M), '+150 m');
  assert.equal(fmtSnowDepth(12.7, {units: 'imperial', signed: true}), '+5 in');
  assert.equal(compass(350), 'N');
  assert.equal(compass(225), 'SW');
});

test('conversions round-trip', () => {
  assert.ok(Math.abs(ftToM(mToFt(1234.5)) - 1234.5) < 1e-9);
  assert.ok(Math.abs(fToC(cToF(-12.3)) + 12.3) < 1e-9);
  assert.ok(Math.abs(msToMph(0.44704) - 1) < 1e-12);
  assert.equal(cmToIn(2.54), 1);
  assert.equal(mmToIn(25.4), 1);
});

test('preference defaults to imperial, survives blocked storage, and fires the event', () => {
  const events = [];
  globalThis.window = {dispatchEvent: e => events.push(e.detail.units)};
  globalThis.localStorage = {getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); }};
  assert.equal(getUnits(), 'imperial');
  setUnits('metric');
  assert.equal(getUnits(), 'metric');
  assert.deepEqual(events, ['metric']);
  const store = {};
  globalThis.localStorage = {getItem: k => store[k] ?? null, setItem: (k, v) => { store[k] = v; }};
  setUnits('imperial');
  assert.equal(store['skintrack-units'], 'imperial');
  assert.equal(fmtElevation(1000), '3,281 ft');
  delete globalThis.window;
  delete globalThis.localStorage;
});
