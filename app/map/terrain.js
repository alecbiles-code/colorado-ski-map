// Terrain computed in the browser (Tier 1) and point inspection (Tier 1 or Tier 2).
// Tier 1: slope and aspect from the configured Terrarium DEM (Mapterhorn by default) on the Web Mercator grid,
// Horn 3x3 with the exact per-row ground pixel size (terrain-math.js); tile edges use the 8 neighbour tiles.
// Web Mercator grid north is true north, so Tier 1 aspect is already true-north.
// Tier 2: the terrain lane's numeric inspection tiles (UTM 13N 10 m grid), decoded exactly, true-north aspect.
import {CONFIG} from '../config.js';
import {getSet, getTile, registerGenerator, registerPmtiles} from './tiles.js';
import {lonLatToTileFrac, pointInGeometry, tileBbox, bboxIntersects} from '../lib/geo.js';
import * as tm from '../lib/terrain-math.js';

/** The DEM provider in use (config switch). */
export const DEM = CONFIG.terrain.providers[CONFIG.terrain.provider];
const SIZE = DEM.tileSize;

/** PMTiles download archive holding DEM tile z/x/y (Mapterhorn: planet for low zooms, one archive per z6 tile above). */
export function demDownloadArchive(z, x, y, dl = DEM.download) {
  if (!dl) return null;
  return z <= dl.lowMaxzoom ? dl.low : dl.high.replace('{x}', x >> (z - 6)).replace('{y}', y >> (z - 6));
}
const demCache = new Map(); // "z/x/y" -> Promise<Float32Array|null>
const gridCache = new Map(); // "z/x/y" -> Promise<{slope, aspect, elev}>
const CACHE_MAX = 48;

/** Slope class colours: the same palette as the Tier 2 display tiles (terrain-slope-pilot.meta.json classes). */
export const SLOPE_COLORS = {lt25: null, s25: [247, 209, 61], s30: [251, 155, 6], s35: [237, 105, 37], s40: [188, 55, 84], s45: [86, 16, 110]};
/** Aspect colours for 8 compass sectors plus flat. */
export const ASPECT_COLORS = {N: [33, 102, 172], NE: [103, 169, 207], E: [209, 229, 240], SE: [253, 219, 199],
  S: [239, 138, 98], SW: [178, 24, 43], W: [118, 42, 131], NW: [64, 0, 110], flat: null};
/** Map zoom from which Tier 1 shading draws (tile pixels at most about 30 m: 29 m at 11, 15 m at 12, 7.3 m from 13). */
export const SLOPE_MIN_MAPZOOM = 11;

// {regions: [{id, title, num, coverage, bbox, setId}] (numeric, exact tap values), displays: [{coverage, bbox}], display}
let tier2 = null;

function remember(cache, key, promise) {
  cache.set(key, promise);
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
  promise.catch(() => cache.delete(key));
  return promise;
}

/** 2D canvas of the tile size. OffscreenCanvas needs iOS Safari 16.4; older versions get a DOM canvas. */
const newCanvas = () => (typeof OffscreenCanvas === 'function' ? new OffscreenCanvas(SIZE, SIZE)
  : Object.assign(document.createElement('canvas'), {width: SIZE, height: SIZE}));
const toPng = c => (c.convertToBlob ? c.convertToBlob({type: 'image/png'})
  : new Promise((resolve, reject) => c.toBlob(b => (b ? resolve(b) : reject(new Error('PNG encoding failed'))), 'image/png')));

/** Decode a Terrarium image into elevations in metres (Float32Array, row-major, north row first). */
async function decodeDem(bytes) {
  const bmp = await createImageBitmap(new Blob([bytes], {type: DEM.mime}), {premultiplyAlpha: 'none', colorSpaceConversion: 'none'});
  const canvas = newCanvas();
  const ctx = canvas.getContext('2d', {willReadFrequently: true});
  ctx.drawImage(bmp, 0, 0, SIZE, SIZE);
  const px = ctx.getImageData(0, 0, SIZE, SIZE).data;
  const out = new Float32Array(SIZE * SIZE);
  for (let i = 0; i < out.length; i++) out[i] = tm.decodeTerrarium(px[4 * i], px[4 * i + 1], px[4 * i + 2]);
  return out;
}

/**
 * DEM tile through the shared tile path (offline first). Resolves null when the tile does not exist.
 * The promise is cached and shared by every tile and tap that needs it, so it takes no abort signal: one
 * cancelled map tile must not fail the others.
 */
export function demTile(z, x, y) {
  const n = 2 ** z;
  const xx = ((x % n) + n) % n;
  if (y < 0 || y >= n) return Promise.resolve(null);
  const key = `${z}/${xx}/${y}`;
  if (demCache.has(key)) return demCache.get(key);
  return remember(demCache, key, getTile('dem', z, xx, y).then(r => (r.data ? decodeDem(r.data) : null)));
}

/** (SIZE+2)^2 elevation grid: the tile plus a one-pixel border from its neighbours (edge-clamped if missing). */
async function paddedDem(z, x, y) {
  const tiles = await Promise.all([-1, 0, 1].flatMap(dy => [-1, 0, 1].map(dx =>
    demTile(z, x + dx, y + dy).catch(err => { if (dx === 0 && dy === 0) throw err; return null; }))));
  const center = tiles[4];
  if (!center) return null;
  const P = SIZE + 2;
  const out = new Float32Array(P * P);
  for (let r = -1; r <= SIZE; r++) {
    for (let c = -1; c <= SIZE; c++) {
      const ty = r < 0 ? 0 : r >= SIZE ? 2 : 1; const tx = c < 0 ? 0 : c >= SIZE ? 2 : 1;
      const t = tiles[ty * 3 + tx];
      const rr = (r + SIZE) % SIZE; const cc = (c + SIZE) % SIZE;
      out[(r + 1) * P + (c + 1)] = t ? t[rr * SIZE + cc] : center[Math.min(SIZE - 1, Math.max(0, r)) * SIZE + Math.min(SIZE - 1, Math.max(0, c))];
    }
  }
  return out;
}

/**
 * Slope and aspect for a tile from its padded elevation grid (pure; exported for tests).
 * @param {Float32Array} dem (size+2)^2 elevations, north row first; z, y: tile zoom and row
 */
export function slopeFromPadded(dem, z, y, size = SIZE) {
  const P = size + 2;
  const slope = new Float32Array(size * size); const aspect = new Float32Array(size * size); const elev = new Float32Array(size * size);
  const w = new Array(9);
  for (let r = 0; r < size; r++) {
    const {dx, dy} = tm.mercatorPixelSize(z, tm.mercatorRowLatitude(z, y * size + r, size), size);
    for (let c = 0; c < size; c++) {
      for (let k = 0; k < 9; k++) w[k] = dem[(r + Math.floor(k / 3)) * P + c + (k % 3)];
      const s = tm.hornSlopeAspect(w, dx, dy);
      const i = r * size + c;
      slope[i] = s.slope ?? NaN; aspect[i] = s.aspect ?? NaN; elev[i] = w[4];
    }
  }
  return {slope, aspect, elev};
}

/** Slope and aspect for every pixel of a tile (Tier 1). Cached and shared, so no abort signal (see demTile). */
export function slopeGrid(z, x, y) {
  const key = `${z}/${x}/${y}`;
  if (gridCache.has(key)) return gridCache.get(key);
  // ponytail: a cancelled map tile still finishes its DEM fetches (they stay cached); add per-request refcounted abort if panning wastes too much data.
  return remember(gridCache, key, paddedDem(z, x, y).then(dem => (dem ? slopeFromPadded(dem, z, y) : null)));
}

/** Longitudes where a ring crosses a latitude, sorted (scanline for the Tier 2 mask). */
function crossings(ring, lat) {
  const xs = [];
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [x1, y1] = ring[j]; const [x2, y2] = ring[i];
    if ((y1 > lat) !== (y2 > lat)) xs.push(x1 + ((lat - y1) * (x2 - x1)) / (y2 - y1));
  }
  return xs.sort((a, b) => a - b);
}

/** Per-pixel mask: 1 where any Tier 2 display region covers the pixel (Tier 1 stays transparent there). */
function tier2Mask(z, x, y) {
  const tb = tileBbox(z, x, y);
  const hit = (tier2?.displays || []).filter(d => d.coverage?.type === 'Polygon' && bboxIntersects(d.bbox, tb));
  if (!hit.length) return null;
  const mask = new Uint8Array(SIZE * SIZE);
  const n = 2 ** z * SIZE;
  for (const d of hit) {
    const ring = d.coverage.coordinates[0];
    for (let r = 0; r < SIZE; r++) {
      const xs = crossings(ring, tm.mercatorRowLatitude(z, y * SIZE + r, SIZE));
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const c0 = Math.max(0, Math.ceil(((xs[k] + 180) / 360) * n - x * SIZE - 0.5));
        const c1 = Math.min(SIZE - 1, Math.floor(((xs[k + 1] + 180) / 360) * n - x * SIZE - 0.5));
        for (let c = c0; c <= c1; c++) mask[r * SIZE + c] = 1;
      }
    }
  }
  return mask;
}

/** Render a slope or aspect tile as PNG bytes. */
async function renderTile(mode, z, x, y) {
  const g = await slopeGrid(z, x, y);
  const canvas = newCanvas();
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(SIZE, SIZE);
  const mask = g && mode === 'slope' ? tier2Mask(z, x, y) : null;
  for (let i = 0; g && i < SIZE * SIZE; i++) {
    if (mask?.[i]) continue;
    const s = g.slope[i];
    const color = mode === 'slope'
      ? (Number.isNaN(s) ? null : SLOPE_COLORS[tm.slopeClass(s).id])
      : (Number.isNaN(g.aspect[i]) ? null : ASPECT_COLORS[tm.aspectName(g.aspect[i], 8)]);
    if (!color) continue;
    img.data.set([color[0], color[1], color[2], 255], 4 * i);
  }
  ctx.putImageData(img, 0, 0);
  return (await toPng(canvas)).arrayBuffer();
}

/** Register Tier 1 generators: skt://terrain/slope/{z}/{x}/{y} and skt://terrain/aspect/{z}/{x}/{y}. */
export function installTerrain() {
  registerGenerator('terrain', (mode, z, x, y) => renderTile(mode === 'aspect' ? 'aspect' : 'slope', z, x, y));
}

/** Map source for Tier 1 slope or aspect shading. MapLibre draws 512 px tiles at the map zoom, 256 px tiles one zoom higher. */
export const tier1Source = mode => ({type: 'raster', tiles: [`skt://terrain/${mode}/{z}/{x}/{y}`], tileSize: SIZE,
  minzoom: SLOPE_MIN_MAPZOOM + Math.log2(512 / SIZE), maxzoom: DEM.maxzoom});

/**
 * Enable Tier 2: numeric regions give exact tap values; display regions mask Tier 1 shading where Tier 2 tiles draw.
 * @param {object[]} numericMetas terrain-numeric product meta files (each with url, numeric, coverage, bbox)
 * @param {object[]} displayMetas terrain-display slope product meta files (each with coverage, bbox)
 */
export function setTier2(numericMetas, displayMetas = []) {
  const regions = numericMetas.map(m => {
    const setId = `t2num:${m.id}`;
    if (!getSet(setId)) registerPmtiles(setId, [{url: m.url, minzoom: m.numeric.tileZ, maxzoom: m.numeric.tileZ}], {tileType: 'numeric'});
    return {id: m.id, title: m.title || m.id, num: m.numeric, coverage: m.coverage, bbox: m.bbox, setId};
  });
  tier2 = {regions, displays: displayMetas.map(m => ({coverage: m.coverage, bbox: m.bbox})), display: displayMetas.length > 0};
}
export const tier2Info = () => tier2;
/** The Tier 2 numeric region containing a point, or null. */
export const tier2RegionAt = (lon, lat) => tier2?.regions.find(r => pointInGeometry([lon, lat], r.coverage)) || null;

const numCache = new Map();
/** Inspect with Tier 2 if the point is inside a numeric region. Returns null outside every region. */
async function inspectTier2(lon, lat) {
  const reg = tier2RegionAt(lon, lat);
  if (!reg) return null;
  const cell = tm.numericCellAt(lon, lat, reg.num);
  if (!cell) return null;
  const key = `${reg.setId}/${cell.z}/${cell.x}/${cell.y}`;
  if (!numCache.has(key)) {
    remember(numCache, key, getTile(reg.setId, cell.z, cell.x, cell.y).then(r => (r.data
      ? tm.decodeNumericTile(new Uint8Array(r.data), reg.num.blockCells + 2 * reg.num.apronCells) : null)));
  }
  const elev = await numCache.get(key);
  if (!elev) return null;
  return {...tm.inspectNumericCell(elev, cell, reg.num), tier: 2, provider: 'USGS 3DEP 1/3 arc-second',
    source: `USGS 3DEP 1/3 arc-second on the 10 m UTM 13N analysis grid (Tier 2, ${reg.id})`, resolutionM: reg.num.resM};
}

/** Tier 1 inspection at the DEM's top zoom (the finest pixels the shading uses). */
async function inspectTier1(lon, lat) {
  const z = DEM.maxzoom;
  const [fx, fy] = lonLatToTileFrac(lon, lat, z);
  const x = Math.floor(fx); const y = Math.floor(fy);
  const g = await slopeGrid(z, x, y);
  if (!g) return null;
  const i = Math.min(SIZE - 1, Math.floor((fy - y) * SIZE)) * SIZE + Math.min(SIZE - 1, Math.floor((fx - x) * SIZE));
  const num = v => (Number.isNaN(v) ? null : v);
  return {elevationM: num(g.elev[i]), slopeDeg: num(g.slope[i]), aspectDeg: num(g.aspect[i]), tier: 1, provider: DEM.name,
    source: `${DEM.name} terrain tiles (${DEM.sourceNote}), computed in this browser`, resolutionM: tm.mercatorPixelSize(z, lat, SIZE).dx};
}

/** Elevation, slope and aspect under a point, preferring Tier 2. Never throws; returns {error} on failure. */
export async function inspectTerrain(lon, lat) {
  try {
    const t2 = await inspectTier2(lon, lat).catch(() => null);
    if (t2 && t2.elevationM !== null) return t2;
    const t1 = await inspectTier1(lon, lat);
    return t1 || {error: 'No elevation data here.'};
  } catch (err) {
    return {error: navigator.onLine === false ? 'Offline, and this point is not inside a downloaded area.' : `Terrain unavailable (${err.message}).`};
  }
}
