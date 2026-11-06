// Tier 2 multi-region routing against the real data/terrain meta files (no browser needed).
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, readdirSync} from 'node:fs';
import {setTier2, tier2RegionAt, tier2Info} from '../app/map/terrain.js';
import {getSet} from '../app/map/tiles.js';
import {numericCellAt} from '../app/lib/terrain-math.js';

const dir = new URL('../data/terrain/', import.meta.url);
const metas = readdirSync(dir).filter(f => f.endsWith('.meta.json')).map(f => JSON.parse(readFileSync(new URL(f, dir), 'utf8')));
const numerics = metas.filter(m => m.kind === 'terrain-numeric');
const displays = metas.filter(m => m.kind === 'terrain-display');

test('every numeric region registers its own tile set and routes points inside it', () => {
  setTier2(numerics, displays);
  assert.equal(tier2Info().regions.length, numerics.length);
  for (const r of tier2Info().regions) assert.ok(getSet(r.setId), `set ${r.setId} registered`);
  const berthoud = tier2RegionAt(-105.7772, 39.7983);
  assert.ok(berthoud, 'Berthoud Pass has Tier 2 numbers');
  assert.ok(numericCellAt(-105.7772, 39.7983, berthoud.num), 'Berthoud cell resolves in its region grid');
  assert.equal(tier2RegionAt(-104.99, 39.74), null, 'Denver is outside every region');
});

test('regions processed beyond the pilot route to their own part archive', {skip: !numerics.some(m => /n40w107/.test(m.id))}, () => {
  setTier2(numerics, displays);
  const vailPass = tier2RegionAt(-106.2167, 39.5306);
  assert.ok(vailPass && /n40w107/.test(vailPass.id), `Vail Pass routes to an n40w107 part, got ${vailPass?.id}`);
  assert.ok(numericCellAt(-106.2167, 39.5306, vailPass.num));
  const ids = new Set([[-106.9, 39.9], [-106.1, 39.9], [-106.9, 39.1], [-106.1, 39.1]].map(([lon, lat]) => tier2RegionAt(lon, lat)?.id));
  assert.equal(ids.size, 4, 'the four quarter archives each answer for their own quarter');
});

test('display regions are listed for Tier 1 masking', () => {
  setTier2(numerics, displays);
  assert.equal(tier2Info().display, displays.length > 0);
  assert.equal(tier2Info().displays.length, displays.length);
  for (const d of tier2Info().displays) assert.equal(d.coverage.type, 'Polygon');
});

test('the pilot products drop out once regional cells cover the whole pilot box', async () => {
  const {withoutRedundantPilot} = await import('../app/layers/terrain.js');
  const box = (id, bbox) => ({id, bbox});
  const pilot = box('terrain-slope-pilot', [-106.005, 39.577, -105.617, 39.923]);
  const w106 = box('terrain-slope-n40w106', [-106, 39, -105, 40]);
  const w107 = box('terrain-slope-n40w107', [-107, 39, -106, 40]);
  assert.deepEqual(withoutRedundantPilot([pilot, w106, w107]).map(m => m.id), [w106.id, w107.id]);
  assert.deepEqual(withoutRedundantPilot([pilot, w107]).map(m => m.id), [pilot.id, w107.id], 'kept while part of the pilot is uncovered');
  assert.deepEqual(withoutRedundantPilot([pilot]).map(m => m.id), [pilot.id]);
  const parts = ['nw', 'ne', 'sw', 'se'].map(p => box(`terrain-numeric-n40w106-${p}`, null));
  parts[0].bbox = [-106, 39.5, -105.5, 40]; parts[1].bbox = [-105.5, 39.5, -105, 40]; parts[2].bbox = [-106, 39, -105.5, 39.5]; parts[3].bbox = [-105.5, 39, -105, 39.5];
  const w107parts = [box('terrain-numeric-n40w107-ne', [-106.5, 39.5, -106, 40])];
  assert.equal(withoutRedundantPilot([box('terrain-numeric-pilot', pilot.bbox), ...parts, ...w107parts]).length, 5);
});
