// Offline package planning (pure): which tile sets, which zooms, how many tiles, estimated bytes.
// Only sets whose providers permit offline storage are ever planned (candidateSets in app/ui/offline.js).
import {bboxIntersection, bboxIntersects, countTiles, enumerateTiles} from '../lib/geo.js';

/**
 * Plan a package.
 * @param {number[]} bbox area [w, s, e, n]
 * @param {number} maxzoom highest zoom requested
 * @param {Array<{id: string, minzoom: number, maxzoom: number, bounds?: number[], avgBytes: number, scheme?: string, keys?: number[][]}>} sets
 * @returns {{bbox: number[], maxzoom: number, sets: Array<{id, minzoom, maxzoom, bbox, tiles, estBytes, keys?}>, tiles: number, estBytes: number}}
 */
export function planPackage(bbox, maxzoom, sets) {
  const out = [];
  for (const s of sets) {
    if (s.keys) { out.push({id: s.id, keys: s.keys, tiles: s.keys.length, estBytes: s.keys.length * s.avgBytes}); continue; }
    if (s.bounds && !bboxIntersects(s.bounds, bbox)) continue;
    const area = s.bounds ? bboxIntersection(s.bounds, bbox) : bbox;
    const z1 = Math.min(maxzoom, s.maxzoom);
    if (z1 < s.minzoom) continue;
    const tiles = countTiles(area, s.minzoom, z1);
    out.push({id: s.id, minzoom: s.minzoom, maxzoom: z1, bbox: area, tiles, estBytes: tiles * s.avgBytes});
  }
  return {bbox, maxzoom, sets: out, tiles: out.reduce((a, s) => a + s.tiles, 0), estBytes: out.reduce((a, s) => a + s.estBytes, 0)};
}

/** Every [setId, z, x, y] of a plan, low zooms first within each set. */
export function* planTiles(plan) {
  for (const s of plan.sets) {
    if (s.keys) { for (const [z, x, y] of s.keys) yield [s.id, z, x, y]; continue; }
    for (const [z, x, y] of enumerateTiles(s.bbox, s.minzoom, s.maxzoom)) yield [s.id, z, x, y];
  }
}

/** Human-readable byte size. */
export function fmtBytes(n) {
  if (!Number.isFinite(n)) return 'n/a';
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1073741824) return `${(n / 1048576).toFixed(1)} MB`;
  return `${(n / 1073741824).toFixed(2)} GB`;
}

/** Numeric (UTM block) tile keys covering a bbox, given a function from lon/lat to block key. */
export function numericKeys(bbox, cellAt, steps = 24) {
  const keys = new Map();
  for (let i = 0; i <= steps; i++) {
    for (let j = 0; j <= steps; j++) {
      const c = cellAt(bbox[0] + ((bbox[2] - bbox[0]) * i) / steps, bbox[1] + ((bbox[3] - bbox[1]) * j) / steps);
      if (c) keys.set(`${c.z}/${c.x}/${c.y}`, [c.z, c.x, c.y]);
    }
  }
  return [...keys.values()];
}
