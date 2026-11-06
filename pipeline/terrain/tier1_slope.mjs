// Tier 1 slope/aspect on a Terrarium RGB mosaic, using app/lib/terrain-math.js exactly as the
// browser does (Terrarium decode, ellipsoidal Web Mercator pixel size per row, Horn 3x3).
// Usage: node tier1_slope.mjs <mosaic.rgb> <header.json> <out.f32>
// Input: raw uint8 RGB, row-major. Header: { z, y0, width, height, tileSize } where y0 is the
// global pixel row of mosaic row 0. Output: float32 slope plane then aspect plane (NaN = none).
import { readFileSync, writeFileSync } from 'node:fs';
import { decodeTerrarium, hornSlopeAspect, mercatorPixelSize, mercatorRowLatitude } from '../../app/lib/terrain-math.js';

const [rgbPath, headerPath, outPath] = process.argv.slice(2);
const { z, y0, width: W, height: H, tileSize } = JSON.parse(readFileSync(headerPath, 'utf8'));
const rgb = readFileSync(rgbPath);
const elev = new Float64Array(W * H);
for (let k = 0; k < W * H; k++) elev[k] = decodeTerrarium(rgb[3 * k], rgb[3 * k + 1], rgb[3 * k + 2]);

const out = new Float32Array(2 * W * H).fill(NaN);
const w = new Array(9);
for (let r = 1; r < H - 1; r++) {
  const { dx, dy } = mercatorPixelSize(z, mercatorRowLatitude(z, y0 + r, tileSize), tileSize);
  for (let c = 1; c < W - 1; c++) {
    let k = 0;
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) w[k++] = elev[(r + i) * W + c + j];
    const res = hornSlopeAspect(w, dx, dy);
    out[r * W + c] = res.slope ?? NaN;
    out[W * H + r * W + c] = res.aspect ?? NaN;
  }
}
writeFileSync(outPath, Buffer.from(out.buffer));
