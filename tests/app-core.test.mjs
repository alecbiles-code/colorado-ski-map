// node --test tests/app-core.test.mjs : pure logic of the app shell (tiles, plans, imports, hash, search).
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, readdirSync, statSync} from 'node:fs';
import {join} from 'node:path';
import {countTiles, enumerateTiles, lat2y, lon2x, parseCoordinates, tileBbox, tileRange} from '../app/lib/geo.js';
import {fmtBytes, numericKeys, planPackage, planTiles} from '../app/offline/planner.js';
import {ImportError, gpxToFeatures, parseRouteFile, parseXml, toGeojson, toGpx} from '../app/lib/validate.js';
import {buildHash, parseHash} from '../app/lib/hash.js';
import {cleanText, escapeXml, safeUrl} from '../app/lib/escape.js';

const LIMITS = {maxBytes: 5 * 1024 * 1024, maxFeatures: 2000, maxVertices: 200000, maxNameLength: 200, maxNoteLength: 4000};

test('tile math: Berthoud Pass at z12 and tile bbox round trip', () => {
  assert.equal(lon2x(-105.777, 12), 844); // floor((74.223/360) * 4096)
  const y = lat2y(39.798, 12);
  const [w, s, e, n] = tileBbox(12, 844, y);
  assert.ok(w <= -105.777 && e >= -105.777 && s <= 39.798 && n >= 39.798);
});

test('tile enumeration matches counts and covers the bbox edges inclusively', () => {
  const bbox = [-106.0, 39.58, -105.62, 39.92];
  for (let z = 0; z <= 14; z++) {
    const [x0, y0, x1, y1] = tileRange(bbox, z);
    assert.equal(countTiles(bbox, z, z), (x1 - x0 + 1) * (y1 - y0 + 1));
  }
  const tiles = [...enumerateTiles(bbox, 10, 12)];
  assert.equal(tiles.length, countTiles(bbox, 10, 12));
  assert.deepEqual(tiles[0].slice(0, 1), [10]);
  assert.equal(new Set(tiles.map(t => t.join('/'))).size, tiles.length);
  // A bbox ending exactly on a tile edge must not pull in the next tile.
  const edge = tileBbox(5, 6, 12);
  assert.equal(countTiles(edge, 5, 5), 1);
});

test('package plan: per-set zoom clamp, bounds clipping, estimates', () => {
  const bbox = [-105.9, 39.7, -105.7, 39.85];
  const plan = planPackage(bbox, 13, [
    {id: 'basemap', minzoom: 0, maxzoom: 14, avgBytes: 6000},
    {id: 'terrarium', minzoom: 0, maxzoom: 14, avgBytes: 90000},
    {id: 'far', minzoom: 0, maxzoom: 14, avgBytes: 1, bounds: [-108, 37, -107, 38]},
    {id: 't2num', keys: [[9, 1, 2], [9, 1, 3]], avgBytes: 34000}
  ]);
  assert.deepEqual(plan.sets.map(s => s.id), ['basemap', 'terrarium', 't2num']);
  assert.equal(plan.sets[0].maxzoom, 13);
  const n = countTiles(bbox, 0, 13);
  assert.equal(plan.sets[0].tiles, n);
  assert.equal(plan.tiles, 2 * n + 2);
  assert.equal(plan.estBytes, n * 6000 + n * 90000 + 2 * 34000);
  assert.equal([...planTiles(plan)].length, plan.tiles);
  assert.equal(fmtBytes(1536), '2 KB');
  assert.equal(fmtBytes(5 * 1048576), '5.0 MB');
});

test('numeric keys sample every block under a bbox', () => {
  const cellAt = (lon, lat) => ({z: 9, x: Math.floor(lon * 10), y: Math.floor(lat * 10)});
  const keys = numericKeys([1.0, 1.0, 1.29, 1.19], cellAt, 40);
  assert.equal(keys.length, 3 * 2);
});

test('coordinates: lat, lon order, hemispheres, rejection', () => {
  assert.deepEqual(parseCoordinates('39.798, -105.777'), [-105.777, 39.798]);
  assert.deepEqual(parseCoordinates('-105.777 39.798'), [-105.777, 39.798]);
  assert.deepEqual(parseCoordinates('39.798N 105.777W'), [-105.777, 39.798]);
  assert.equal(parseCoordinates('Berthoud Pass'), null);
  assert.equal(parseCoordinates('95, 200'), null);
});

const GPX = `<?xml version="1.0"?>
<gpx version="1.1" creator="t" xmlns="http://www.topografix.com/GPX/1/1">
  <wpt lat="39.798" lon="-105.777"><ele>3446</ele><name>Berthoud &amp; friends &lt;b&gt;</name></wpt>
  <trk><name><![CDATA[Tour <script>]]></name><trkseg>
    <trkpt lat="39.80" lon="-105.78"><ele>3400</ele></trkpt><trkpt lat="39.81" lon="-105.79"/>
  </trkseg></trk>
</gpx>`;

test('GPX: waypoints and tracks, entities and CDATA decoded as text', () => {
  const f = gpxToFeatures(GPX);
  assert.equal(f.length, 2);
  assert.deepEqual(f[0].geometry, {type: 'Point', coordinates: [-105.777, 39.798, 3446]});
  assert.equal(f[0].properties.name, 'Berthoud & friends <b>');
  assert.equal(f[1].geometry.type, 'LineString');
  assert.equal(f[1].properties.name, 'Tour <script>');
  assert.deepEqual(f[1].geometry.coordinates[1], [-105.79, 39.81]);
});

test('GPX: malformed, DOCTYPE and bad coordinates are rejected', () => {
  assert.throws(() => parseXml('<gpx><trk></gpx>'), ImportError);
  assert.throws(() => parseXml('<!DOCTYPE x [<!ENTITY a "b">]><gpx/>'), ImportError);
  assert.throws(() => gpxToFeatures('<gpx><wpt lat="999" lon="0"/></gpx>'), ImportError);
  assert.throws(() => gpxToFeatures('<kml/>'), /Not a GPX/);
});

test('GeoJSON import: validation, limits, cleaning, unsupported types', () => {
  const fc = {type: 'FeatureCollection', features: [
    {type: 'Feature', properties: {name: '  Line\u0007 ', evil: '<img>'}, geometry: {type: 'LineString', coordinates: [[-105.8, 39.8], [-105.81, 39.81, 3400]]}},
    {type: 'Feature', properties: {}, geometry: {type: 'GeometryCollection', geometries: []}}]};
  const out = parseRouteFile('a.geojson', JSON.stringify(fc), LIMITS);
  assert.equal(out.features.length, 1);
  assert.equal(out.features[0].properties.name, 'Line');
  assert.equal(out.features[0].properties.evil, undefined);
  assert.throws(() => parseRouteFile('a.geojson', '{"type":"Point","coordinates":[39.8,-105.8,1]}', LIMITS), /out of range/);
  assert.throws(() => parseRouteFile('a.geojson', 'not json', LIMITS), /not valid JSON/);
  assert.throws(() => parseRouteFile('a.txt', 'hello', LIMITS), /Unsupported/);
  assert.throws(() => parseRouteFile('a.geojson', 'x'.repeat(10), {...LIMITS, maxBytes: 5}), /larger/);
  const many = {type: 'FeatureCollection', features: Array.from({length: 3}, () => ({type: 'Feature', properties: {}, geometry: {type: 'Point', coordinates: [0, 0]}}))};
  assert.throws(() => parseRouteFile('m.json', JSON.stringify(many), {...LIMITS, maxFeatures: 2}), /Too many features/);
  assert.throws(() => parseRouteFile('m.json', JSON.stringify(many), {...LIMITS, maxVertices: 2}), /Too many points/);
});

test('export round trip: GPX escapes text and re-imports; GeoJSON is valid JSON', () => {
  const feats = parseRouteFile('t.gpx', GPX, LIMITS).features;
  const gpx = toGpx(feats);
  assert.ok(gpx.includes('&lt;script&gt;') && !gpx.includes('<script>'));
  const again = parseRouteFile('t.gpx', gpx, LIMITS).features;
  assert.deepEqual(again.map(f => f.geometry), feats.map(f => f.geometry));
  assert.deepEqual(again.map(f => f.properties.name), feats.map(f => f.properties.name));
  assert.equal(JSON.parse(toGeojson(feats)).features.length, 2);
});

test('hash: keeps map=, round trips selection and view, rejects junk', () => {
  const h = buildHash('#map=12/39.8/-105.8', {sel: {lon: -105.777, lat: 39.798, name: 'Berthoud Pass & co'}, view: 'conditions'});
  assert.ok(h.startsWith('#map=12/39.8/-105.8&'));
  assert.deepEqual(parseHash(h), {sel: {lon: -105.777, lat: 39.798, name: 'Berthoud Pass & co'}, view: 'conditions'});
  assert.equal(buildHash(h, {sel: null, view: 'map'}), '#map=12/39.8/-105.8');
  assert.deepEqual(parseHash('#sel=999,5&v=evil'), {sel: null, view: null});
  assert.deepEqual(parseHash('#sel=39.8,-105.8&name=%E0%A4%A'), {sel: {lon: -105.8, lat: 39.8}, view: null});
});

test('escaping helpers', () => {
  assert.equal(escapeXml(`<a href="x">'&`), '&lt;a href=&quot;x&quot;&gt;&apos;&amp;');
  assert.equal(safeUrl('javascript:alert(1)'), null);
  assert.equal(safeUrl('https://avalanche.state.co.us/'), 'https://avalanche.state.co.us/');
  assert.equal(cleanText('x'.repeat(10), 5).length, 5);
});

test('service worker shell list covers every shipped app, vendor and asset file', () => {
  const root = new URL('..', import.meta.url).pathname;
  const sw = readFileSync(join(root, 'sw.js'), 'utf8');
  const walk = d => readdirSync(join(root, d)).flatMap(n => (statSync(join(root, d, n)).isDirectory() ? walk(join(d, n)) : [join(d, n)]));
  const shipped = ['app', 'vendor', 'assets'].flatMap(walk).filter(p => /\.(js|css|pbf|png|json)$/.test(p) && !p.endsWith('.mjs'));
  const missing = shipped.filter(p => !sw.includes(`'${p}'`));
  assert.deepEqual(missing, []);
  assert.match(sw, /k\.startsWith\('skintrack-shell-'\)/);
  assert.match(sw, /headers\.has\('range'\)/);
});

test('tile path: first archive covering the tile wins, none means empty, network errors surface', async () => {
  const calls = [];
  globalThis.pmtiles = {PMTiles: class {
    constructor(url) { this.url = url; }
    async getZxy(z, x, y) { calls.push(`${this.url}:${z}`); if (this.url.includes('broken')) throw new Error('net'); return this.url.includes('empty') ? undefined : {data: new Uint8Array([z]).buffer}; }
  }};
  const {registerPmtiles, getTile} = await import('../app/map/tiles.js');
  registerPmtiles('t', [
    {url: 'https://x/low.pmtiles', minzoom: 0, maxzoom: 10, bounds: [-109.06, 36.99, -102.04, 41.01]},
    {url: 'https://x/empty.pmtiles', minzoom: 12, maxzoom: 14, bounds: [-106, 39, -105, 40]},
    {url: 'https://x/cell.pmtiles', minzoom: 12, maxzoom: 14, bounds: [-106, 39, -105, 40]}]);
  const z12 = [12, 844, 1550]; // near Berthoud Pass
  assert.deepEqual(new Uint8Array((await getTile('t', ...z12)).data), new Uint8Array([12]));
  assert.ok(calls.includes('https://x/empty.pmtiles:12') && calls.includes('https://x/cell.pmtiles:12'));
  assert.equal((await getTile('t', 11, 422, 775)).data, null); // no archive holds z11
  assert.equal((await getTile('t', 12, 100, 100)).data, null); // outside every bounds
  registerPmtiles('b', [{url: 'https://x/broken.pmtiles', minzoom: 0, maxzoom: 14}]);
  await assert.rejects(getTile('b', 12, 844, 1550), /net/);
});

test('Mapterhorn download archive naming', async () => {
  const {demDownloadArchive} = await import('../app/map/terrain.js');
  const dl = {low: 'L', lowMaxzoom: 12, high: 'https://d/6-{x}-{y}.pmtiles'};
  assert.equal(demDownloadArchive(12, 850, 1550, dl), 'L');
  assert.equal(demDownloadArchive(13, 1700, 3100, dl), 'https://d/6-13-24.pmtiles');
  assert.equal(demDownloadArchive(13, 1663, 3100, dl), 'https://d/6-12-24.pmtiles');
});

test('Tier 1 slope on synthetic planes uses the true per-row ground pixel size', async () => {
  const {slopeFromPadded} = await import('../app/map/terrain.js');
  const tm = await import('../app/lib/terrain-math.js');
  const size = 64; const z = 15; const y = 12400; // about 39.8 N at z15 with 64 px tiles
  const P = size + 2; const t = Math.tan((30 * Math.PI) / 180);
  const north = new Float32Array(P * P); const east = new Float32Array(P * P);
  let cumN = 0;
  for (let r = 0; r < P; r++) {
    const {dx, dy} = tm.mercatorPixelSize(z, tm.mercatorRowLatitude(z, y * size + r - 1, size), size);
    if (r) cumN += dy;
    for (let c = 0; c < P; c++) { north[r * P + c] = -t * cumN; east[r * P + c] = t * c * dx; }
  }
  const a = slopeFromPadded(north, z, y, size); const b = slopeFromPadded(east, z, y, size);
  for (const i of [0, 33 * size + 20, size * size - 1]) {
    assert.ok(Math.abs(a.slope[i] - 30) < 0.01, `north plane slope ${a.slope[i]}`);
    assert.ok(Math.abs(a.aspect[i] - 180) < 0.01, `rises to the north, faces south: ${a.aspect[i]}`);
    assert.ok(Math.abs(b.slope[i] - 30) < 0.01, `east plane slope ${b.slope[i]}`);
    assert.ok(Math.abs(b.aspect[i] - 270) < 0.01, `rises to the east, faces west: ${b.aspect[i]}`);
  }
});
