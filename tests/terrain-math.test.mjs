// node --test tests/terrain-math.test.mjs
// Same synthetic cases as tests/pipeline/test_terrain_core.py, plus browser-only helpers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import {
  SLOPE_CLASSES, aspectName, decodeNumericTile, decodeTerrarium, hornSlopeAspect,
  inspectNumericCell, lonLatToUtm, mercatorPixelSize, mercatorRowLatitude, numericCellAt, regionCellName,
  regionPartName,
  slopeClass, trueNorthAspect, utmConvergenceDeg,
} from '../app/lib/terrain-math.js';

const RAD = Math.PI / 180;
const angleDiff = (a, b) => ((a - b + 540) % 360) - 180;

/** 3x3 window of a plane falling at slopeDeg toward aspectDeg; row 0 = north. */
function planeWindow(slopeDeg, aspectDeg, dx, dy) {
  const w = [];
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) {
    const east = c * dx, north = -r * dy;
    w.push(3000 - Math.tan(slopeDeg * RAD) * (Math.sin(aspectDeg * RAD) * east + Math.cos(aspectDeg * RAD) * north));
  }
  return w;
}

test('planes of known slope and aspect', () => {
  for (const s of [25, 30, 35, 45, 10, 60]) for (const a of [0, 90, 180, 270, 45, 225]) {
    for (const [dx, dy] of [[10, 10], [7.35, 7.32]]) {
      const r = hornSlopeAspect(planeWindow(s, a, dx, dy), dx, dy);
      assert.ok(Math.abs(r.slope - s) < 1e-9, `slope ${s}/${a}: ${r.slope}`);
      assert.ok(Math.abs(angleDiff(r.aspect, a)) < 1e-9, `aspect ${s}/${a}: ${r.aspect}`);
    }
  }
});

test('surface rising east faces west', () => {
  const r = hornSlopeAspect([0, 10, 20, 0, 10, 20, 0, 10, 20], 10, 10);
  assert.ok(Math.abs(r.slope - 45) < 1e-12);
  assert.ok(Math.abs(r.aspect - 270) < 1e-12);
});

test('cone of 35 degrees', () => {
  const k = Math.tan(35 * RAD), d = 10;
  const z = (c, r) => 4000 - k * Math.hypot((c - 100) * d, (100 - r) * d);
  let maxS = 0, maxA = 0;
  for (let r = 1; r < 200; r++) for (let c = 1; c < 200; c++) {
    const east = (c - 100) * d, north = (100 - r) * d;
    if (Math.hypot(east, north) <= 200) continue;
    const w = [];
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) w.push(z(c + j, r + i));
    const res = hornSlopeAspect(w, d, d);
    maxS = Math.max(maxS, Math.abs(res.slope - 35));
    maxA = Math.max(maxA, Math.abs(angleDiff(res.aspect, (Math.atan2(east, north) / RAD + 360) % 360)));
  }
  assert.ok(maxS < 0.05, `cone slope error ${maxS}`);
  assert.ok(maxA < 0.5, `cone aspect error ${maxA}`);
});

test('no data in the window gives null', () => {
  const w = planeWindow(30, 90, 10, 10);
  for (const bad of [NaN, null, undefined, Infinity]) {
    const x = w.slice(); x[0] = bad;
    assert.deepEqual(hornSlopeAspect(x, 10, 10), { slope: null, aspect: null });
  }
});

test('flat and gentle cells have aspect -1', () => {
  assert.deepEqual(hornSlopeAspect(Array(9).fill(2500), 10, 10), { slope: 0, aspect: -1 });
  const r = hornSlopeAspect(planeWindow(0.5, 90, 10, 10), 10, 10);
  assert.ok(Math.abs(r.slope - 0.5) < 1e-9);
  assert.equal(r.aspect, -1);
});

test('slope class boundaries are lower-bound inclusive', () => {
  const cases = [[0, '<25'], [24.999, '<25'], [25, '25-30'], [29.9999, '25-30'], [30, '30-35'],
    [34.99, '30-35'], [35, '35-40'], [40, '40-45'], [44.999, '40-45'], [45, '>=45'], [89.9, '>=45']];
  for (const [v, label] of cases) assert.equal(slopeClass(v).label, label, `${v}`);
  assert.equal(slopeClass(null), null);
  assert.equal(slopeClass(NaN), null);
});

test('slope classes match the published display product', () => {
  const meta = new URL('../data/terrain/terrain-slope-pilot.meta.json', import.meta.url);
  if (!existsSync(meta)) return;
  const published = JSON.parse(readFileSync(meta, 'utf8')).classes;
  assert.deepEqual(published.map((c) => [c.id, c.min, c.max, c.label]),
    SLOPE_CLASSES.map((c) => [c.id, c.min, c.max, c.label]));
});

test('aspect names', () => {
  const eight = [[0, 'N'], [22.4, 'N'], [22.5, 'NE'], [90, 'E'], [180, 'S'], [225, 'SW'], [337.5, 'N'], [359.9, 'N']];
  for (const [d, n] of eight) assert.equal(aspectName(d), n, `${d}`);
  const sixteen = [[0, 'N'], [11.25, 'NNE'], [33.75, 'NE'], [191.25, 'SSW'], [348.75, 'N'], [348.7, 'NNW']];
  for (const [d, n] of sixteen) assert.equal(aspectName(d, 16), n, `${d}`);
  assert.equal(aspectName(-1), 'flat');
  assert.equal(aspectName(null), null);
});

test('Terrarium decode', () => {
  assert.equal(decodeTerrarium(128, 0, 0), 0);
  assert.equal(decodeTerrarium(0, 0, 0), -32768);
  assert.equal(decodeTerrarium(141, 118, 128), 3446.5);
});

test('Web Mercator ground pixel size', () => {
  const eq = mercatorPixelSize(0, 0);
  assert.ok(Math.abs(eq.dx - 156543.03392804097) < 1e-6);
  const p = mercatorPixelSize(14, 39.75);
  const spherical = (2 * Math.PI * 6378137 / (256 * 2 ** 14)) * Math.cos(39.75 * RAD);
  assert.ok(Math.abs(p.dx / spherical - 1) < 0.002 && Math.abs(p.dy / spherical - 1) < 0.003);
  assert.ok(p.dy < spherical && p.dx > spherical);
  assert.equal(mercatorPixelSize(13, 39.75, 512).dx, mercatorPixelSize(14, 39.75).dx);
  assert.ok(Math.abs(mercatorRowLatitude(0, 127.5)) < 1e-12);
});

test('lon/lat to UTM 13N matches pyproj EPSG:4269 -> EPSG:26913 within 1 mm', () => {
  const ref = [[-105.7772, 39.7983, 433463.2869, 4405659.7472], [-106.0, 39.58, 414118.8058, 4381620.5651],
    [-105.62, 39.92, 447015.0928, 4419062.0315], [-109.05, 37.0, 139563.5438, 4102546.1505],
    [-102.04, 41.0, 748956.1462, 4542978.0391], [-105.0, 40.0, 500000.0, 4427757.2186],
    [-107.5, 38.9, 283201.5379, 4308650.7667]];
  for (const [lon, lat, e, n] of ref) {
    const [x, y] = lonLatToUtm(lon, lat);
    assert.ok(Math.abs(x - e) < 0.001 && Math.abs(y - n) < 0.001, `${lon},${lat}: ${x},${y}`);
  }
});

// 4x4 block from pipeline/terrain/numeric_tiles.py encode_block (blockCells 2 + 1-cell apron).
const FIXTURE = 'eNpLEpLgFmVi0xJmYmHhZGVg4WVgmMQAwWDAyMAgzwDBWAEAebQCfg==';
const FIXTURE_VALUES = [34481, 34490, 34502, -1000000, 34470, 34480, 34495, 34510,
  34460, 34471, 34488, 34505, 34455, 34463, 34480, 34499];
const NUM = { blockCells: 2, apronCells: 1, elevScale: 10, nodata: -1000000, resM: 10, flatThresholdDeg: 1 };

test('numeric tile decode matches the Python encoder', async () => {
  const elev = await decodeNumericTile(Buffer.from(FIXTURE, 'base64'), 4);
  assert.deepEqual(Array.from(elev), FIXTURE_VALUES);
  const at = { col: 1, row: 2, cellE: 430565, cellN: 4400345 };
  const cell = inspectNumericCell(elev, at, NUM);
  const w = [0, 1, 2].flatMap((r) => [0, 1, 2].map((c) => FIXTURE_VALUES[(1 + r) * 4 + c] / 10));
  const grid = hornSlopeAspect(w, 10, 10);
  assert.equal(cell.elevationM, 3447.1);
  assert.equal(cell.slopeDeg, grid.slope);
  assert.equal(cell.aspectDeg, trueNorthAspect(grid.aspect, utmConvergenceDeg(430565, 4400345)));
  assert.ok(Math.abs(cell.aspectDeg - (grid.aspect - 0.5182811702)) < 1e-8);
  const edge = inspectNumericCell(elev, { col: 2, row: 1, cellE: 430565, cellN: 4400345 }, NUM); // touches nodata
  assert.equal(edge.elevationM, 3449.5);
  assert.equal(edge.slopeDeg, null);
});

test('numeric cell lookup', () => {
  const num = { utmZone: 13, gridBounds: [414110, 4381320, 447020, 4419360], originE: 0,
    originN: 4700000, resM: 10, blockCells: 256, apronCells: 1, tileZ: 9 };
  assert.deepEqual(numericCellAt(-105.7772, 39.7983, num),
    { z: 9, x: 169, y: 114, col: 83, row: 251, cellE: 433465, cellN: 4405655 });
  assert.equal(numericCellAt(-106.2, 39.7, num), null);
});

test('regional cell ownership', () => {
  assert.equal(regionCellName(-106.5, 39.5), 'n40w107');
  assert.equal(regionCellName(-107.0, 39.5), 'n40w107'); // west edge belongs to the cell
  assert.equal(regionCellName(-106.0, 39.5), 'n40w106'); // east edge belongs to the neighbour
  assert.equal(regionCellName(-106.5, 40.0), 'n40w107'); // north edge belongs to the cell
  assert.equal(regionCellName(-106.5, 39.0), 'n39w107');
  assert.equal(regionPartName(-106.7, 39.7), 'n40w107-nw');
  assert.equal(regionPartName(-106.5, 39.5), 'n40w107-se'); // centre lines belong to south and east
  assert.equal(regionPartName(-107.0, 40.0), 'n40w107-nw');
  assert.equal(regionPartName(-106.01, 39.01), 'n40w107-se');
});

test('meridian convergence matches PROJ and corrects aspect to true north', () => {
  // Reference: pyproj Proj('EPSG:26913').get_factors(lon, lat).meridian_convergence
  const ref = [[414115, 4419355, -0.6449466466], [446995, 4381325, -0.3932570906],
    [430565, 4400345, -0.5182811702], [139565, 4102545, -2.4399651577],
    [748955, 4542975, 1.9429197012], [500000, 4427755, 0], [283205, 4308655, -1.5704957491]];
  for (const [e, n, c] of ref) assert.ok(Math.abs(utmConvergenceDeg(e, n) - c) < 1e-8, `${e},${n}`);
  assert.equal(trueNorthAspect(-1, -0.5), -1);
  assert.equal(trueNorthAspect(null, -0.5), null);
  assert.ok(Math.abs(trueNorthAspect(0.2, -0.5) - 359.7) < 1e-12);
  assert.ok(Math.abs(trueNorthAspect(359.9, 0.5) - 0.4) < 1e-12);
  assert.equal(trueNorthAspect(180, -0.5), 179.5);
});
