// Pure terrain math shared by the browser and node tests. No DOM.
// Conventions: a 3x3 window is [a, b, c, d, e, f, g, h, i], row-major, first row = north.
// Slope in degrees. Aspect = downslope direction, degrees clockwise from the grid's north
// (0 N, 90 E, 180 S, 270 W), -1 = flat (slope below the flat threshold), null = no data.
// Web Mercator grid north is true north. On the UTM analysis grid, hornSlopeAspect gives grid
// aspect and inspectNumericCell converts it to true north with the meridian convergence.
// Must stay numerically identical to pipeline/terrain/terrain_core.py (same operation order).

export const FLAT_THRESHOLD_DEG = 1.0; // pipeline/terrain/config.yaml processing.flat_threshold_deg
const DEG = 180 / Math.PI;

// GRS80 (NAD83). WGS84 differs only in the 11th digit of flattening: irrelevant at these scales.
const A = 6378137;
const F = 1 / 298.257222101;
const E2 = F * (2 - F);
const N = F / (2 - F);
const N2 = N * N, N3 = N2 * N, N4 = N3 * N;
const RECT = (A / (1 + N)) * (1 + N2 / 4 + N4 / 64); // rectifying radius
const K0 = 0.9996;
const ALPHA = [N / 2 - (2 * N2) / 3 + (5 * N3) / 16 + (41 * N4) / 180,
  (13 * N2) / 48 - (3 * N3) / 5 + (557 * N4) / 1440,
  (61 * N3) / 240 - (103 * N4) / 140, (49561 * N4) / 161280];
const BETA = [N / 2 - (2 * N2) / 3 + (37 * N3) / 96, N2 / 48 + N3 / 15, (17 * N3) / 480];

// Slope classes in degrees, lower bound inclusive, upper exclusive (docs/ARCHITECTURE.md 3.3).
export const SLOPE_CLASSES = Object.freeze([
  { id: 'lt25', min: 0, max: 25, label: '<25' },
  { id: 's25', min: 25, max: 30, label: '25-30' },
  { id: 's30', min: 30, max: 35, label: '30-35' },
  { id: 's35', min: 35, max: 40, label: '35-40' },
  { id: 's40', min: 40, max: 45, label: '40-45' },
  { id: 's45', min: 45, max: null, label: '>=45' },
]);

const NAMES_8 = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
const NAMES_16 = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE',
  'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];

/** Terrarium RGB to metres: (R * 256 + G + B / 256) - 32768. */
export function decodeTerrarium(r, g, b) {
  return r * 256 + g + b / 256 - 32768;
}

/**
 * Ground size in metres of one Web Mercator pixel at a geodetic latitude (ellipsoidal).
 * dx is east-west, dy north-south; they differ by about 0.4 % at 40 N.
 */
export function mercatorPixelSize(z, latDeg, tileSize = 256) {
  const m = (2 * Math.PI * A) / (tileSize * 2 ** z);
  const phi = latDeg / DEG;
  const w = 1 - E2 * Math.sin(phi) ** 2;
  return { dx: (m * Math.cos(phi)) / Math.sqrt(w), dy: (m * Math.cos(phi) * (1 - E2)) / w ** 1.5 };
}

/** Latitude (degrees) of the centre of global Web Mercator pixel row yPixel at zoom z. */
export function mercatorRowLatitude(z, yPixel, tileSize = 256) {
  const n = Math.PI * (1 - (2 * (yPixel + 0.5)) / (tileSize * 2 ** z));
  return Math.atan(Math.sinh(n)) * DEG;
}

/** Horn (1981) slope and aspect for a 3x3 window with cell sizes dx, dy in metres. */
export function hornSlopeAspect(w, dx, dy, flatThresholdDeg = FLAT_THRESHOLD_DEG) {
  for (let k = 0; k < 9; k++) if (!Number.isFinite(w[k])) return { slope: null, aspect: null };
  const [a, b, c, d, , f, g, h, i] = w;
  const p = ((c + 2 * f + i) - (a + 2 * d + g)) / (8 * dx); // dz / d(east)
  const q = ((a + 2 * b + c) - (g + 2 * h + i)) / (8 * dy); // dz / d(north)
  const slope = Math.atan(Math.hypot(p, q)) * DEG;
  if (slope < flatThresholdDeg) return { slope, aspect: -1 };
  return { slope, aspect: (Math.atan2(-p, -q) * DEG + 360) % 360 };
}

/** Slope class for a value in degrees, or null for null/NaN. */
export function slopeClass(deg, classes = SLOPE_CLASSES) {
  if (deg == null || Number.isNaN(deg)) return null;
  for (let k = classes.length - 1; k >= 0; k--) if (deg >= classes[k].min) return classes[k];
  return classes[0];
}

/** Compass name for an aspect: 8 or 16 points, 'flat' for -1, null for null. */
export function aspectName(deg, points = 8) {
  if (deg == null || Number.isNaN(deg)) return null;
  if (deg < 0) return 'flat';
  const names = points === 16 ? NAMES_16 : NAMES_8;
  const width = 360 / names.length;
  return names[Math.floor(((deg + width / 2) % 360) / width) % names.length];
}

/**
 * Geographic (NAD83 or WGS84 degrees) to UTM easting/northing, northern hemisphere.
 * Krueger series to n^4 (Karney 2011), sub-millimetre within the zone and a few degrees beyond.
 */
export function lonLatToUtm(lon, lat, zone = 13) {
  const phi = lat / DEG;
  const dl = (lon - (zone * 6 - 183)) / DEG;
  const e = (2 * Math.sqrt(N)) / (1 + N);
  const t = Math.sinh(Math.atanh(Math.sin(phi)) - e * Math.atanh(e * Math.sin(phi)));
  const xi0 = Math.atan2(t, Math.cos(dl));
  const eta0 = Math.atanh(Math.sin(dl) / Math.sqrt(1 + t * t));
  let xi = xi0, eta = eta0;
  for (let j = 1; j <= 4; j++) {
    xi += ALPHA[j - 1] * Math.sin(2 * j * xi0) * Math.cosh(2 * j * eta0);
    eta += ALPHA[j - 1] * Math.cos(2 * j * xi0) * Math.sinh(2 * j * eta0);
  }
  return [500000 + K0 * RECT * eta, K0 * RECT * xi];
}

/**
 * Meridian convergence (degrees) at a UTM point, northern hemisphere (Karney 2011 inverse series).
 * Negative west of the central meridian. True-north azimuth = grid azimuth + convergence.
 */
export function utmConvergenceDeg(e, n) {
  const xi = n / (K0 * RECT);
  const eta = (e - 500000) / (K0 * RECT);
  let xi1 = xi, eta1 = eta, p = 1, q = 0;
  for (let j = 1; j <= 3; j++) {
    const b = BETA[j - 1];
    xi1 = xi1 - b * Math.sin(2 * j * xi) * Math.cosh(2 * j * eta);
    eta1 = eta1 - b * Math.cos(2 * j * xi) * Math.sinh(2 * j * eta);
    p = p - 2 * j * b * Math.cos(2 * j * xi) * Math.cosh(2 * j * eta);
    q = q + 2 * j * b * Math.sin(2 * j * xi) * Math.sinh(2 * j * eta);
  }
  return (Math.atan(Math.tan(xi1) * Math.tanh(eta1)) + Math.atan2(q, p)) * DEG;
}

/** Grid-north aspect to true-north aspect in [0, 360); -1 (flat) and null pass through. */
export function trueNorthAspect(aspectGrid, convergenceDeg) {
  if (aspectGrid == null || aspectGrid < 0) return aspectGrid;
  const t = (aspectGrid + convergenceDeg) % 360;
  return t < 0 ? t + 360 : t;
}

/**
 * Name of the 1x1 degree regional cell that owns lon/lat (e.g. 'n40w107' for lat 39 to 40,
 * lon -107 to -106). Ownership: west edge and north edge inclusive, matching the display tiles.
 */
export function regionCellName(lon, lat) {
  return `n${Math.ceil(lat)}w${Math.ceil(-lon)}`;
}

/**
 * Name of the 0.5 degree part of a regional cell that owns lon/lat, e.g. 'n40w107-ne'.
 * Numeric archives of 1x1 degree cells are split this way (terrain-numeric-<part>.pmtiles).
 */
export function regionPartName(lon, lat) {
  const ns = Math.ceil(lat) - lat < 0.5 ? 'n' : 's';
  const ew = lon - Math.floor(lon) < 0.5 ? 'w' : 'e';
  return `${regionCellName(lon, lat)}-${ns}${ew}`;
}

// ---- Numeric inspection product (see docs/methods/terrain.md section 7) ----
// One tile = one block of blockCells x blockCells analysis cells plus an apron of apronCells on
// every side, holding integer elevations round(z * elevScale) (nodata = meta.nodata). Payload:
// zlib( 4 byte planes of zigzag( 2-D difference residuals ) as uint32 little-endian ).

/** Inflate a zlib (RFC 1950) byte array with the platform DecompressionStream. */
async function inflate(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Decode one numeric tile payload into an Int32Array of quantized elevations (row-major). */
export async function decodeNumericTile(bytes, side) {
  const raw = await inflate(bytes);
  const len = side * side;
  if (raw.length !== 4 * len) throw new Error(`numeric tile: expected ${4 * len} bytes, got ${raw.length}`);
  const out = new Int32Array(len);
  for (let k = 0; k < len; k++) {
    const u = raw[k] | (raw[len + k] << 8) | (raw[2 * len + k] << 16) | (raw[3 * len + k] << 24);
    out[k] = (u >>> 1) ^ -(u & 1); // un-zigzag
  }
  for (let r = 0; r < side; r++) for (let c = 1; c < side; c++) out[r * side + c] += out[r * side + c - 1];
  for (let r = 1; r < side; r++) for (let c = 0; c < side; c++) out[r * side + c] += out[(r - 1) * side + c];
  return out;
}

/**
 * Locate the analysis cell under lon/lat. Returns null outside the product's grid bounds, else
 * { z, x, y } (PMTiles tile key), { col, row } of the cell inside the apron-padded tile and
 * { cellE, cellN }, the UTM coordinates of the cell centre.
 */
export function numericCellAt(lon, lat, num) {
  const [e, nn] = lonLatToUtm(lon, lat, num.utmZone);
  const [xmin, ymin, xmax, ymax] = num.gridBounds;
  if (!(e >= xmin && e < xmax && nn > ymin && nn <= ymax)) return null;
  const gc = Math.floor((e - num.originE) / num.resM);
  const gr = Math.floor((num.originN - nn) / num.resM);
  const x = Math.floor(gc / num.blockCells), y = Math.floor(gr / num.blockCells);
  return { z: num.tileZ, x, y, col: gc - x * num.blockCells + num.apronCells,
    row: gr - y * num.blockCells + num.apronCells,
    cellE: num.originE + (gc + 0.5) * num.resM, cellN: num.originN - (gr + 0.5) * num.resM };
}

/**
 * Elevation (m), slope (deg) and true-north aspect (deg, -1 flat) of a cell from numericCellAt,
 * read from its decoded tile. Equals the Tier 2 rasters for that cell.
 */
export function inspectNumericCell(elev, cell, num) {
  const { col, row } = cell;
  const side = num.blockCells + 2 * num.apronCells;
  const at = (r, c) => {
    const v = elev[r * side + c];
    return v === num.nodata ? NaN : v / num.elevScale;
  };
  const w = [];
  for (let r = row - 1; r <= row + 1; r++) for (let c = col - 1; c <= col + 1; c++) w.push(at(r, c));
  const z = w[4];
  const { slope, aspect } = hornSlopeAspect(w, num.resM, num.resM, num.flatThresholdDeg);
  const aspectDeg = trueNorthAspect(aspect, utmConvergenceDeg(cell.cellE, cell.cellN));
  return { elevationM: Number.isNaN(z) ? null : z, slopeDeg: slope, aspectDeg };
}
