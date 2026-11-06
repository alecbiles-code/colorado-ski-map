// Read the numeric PMTiles archive exactly as the browser does (pmtiles getZxy + terrain-math.js)
// and print elevation/slope/aspect for each lon/lat in a points JSON file.
// Usage: node verify_numeric.mjs <data dir> <product id or "parts"> <points.json> <pmtiles esm index.js>
// With "parts", each point reads terrain-numeric-<regionPartName(lon, lat)>.pmtiles, as the app would.
import { open, readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { decodeNumericTile, inspectNumericCell, numericCellAt, regionPartName } from '../../app/lib/terrain-math.js';

const [dataDir, product, pointsPath, pmtilesModule] = process.argv.slice(2);
const { PMTiles } = await import(pathToFileURL(pmtilesModule).href);

class FileSource {
  constructor(path) { this.path = path; this.fh = null; }
  getKey() { return this.path; }
  async getBytes(offset, length) {
    this.fh ??= await open(this.path, 'r');
    const buf = Buffer.alloc(length);
    const { bytesRead } = await this.fh.read(buf, 0, length, offset);
    return { data: buf.buffer.slice(buf.byteOffset, buf.byteOffset + bytesRead) };
  }
}

const archives = new Map();
async function archiveFor(lon, lat) {
  const id = product === 'parts' ? `terrain-numeric-${regionPartName(lon, lat)}` : product;
  if (!archives.has(id)) {
    const pm = new PMTiles(new FileSource(`${dataDir}/${id}.pmtiles`));
    archives.set(id, { id, pm, num: (await pm.getMetadata()).numeric, tiles: new Map() });
  }
  return archives.get(id);
}

const points = JSON.parse(await readFile(pointsPath, 'utf8'));
const out = [];
for (const [lon, lat] of points) {
  const a = await archiveFor(lon, lat);
  const cell = numericCellAt(lon, lat, a.num);
  if (!cell) { out.push(null); continue; }
  const key = `${cell.x}/${cell.y}`;
  if (!a.tiles.has(key)) {
    const tile = await a.pm.getZxy(cell.z, cell.x, cell.y);
    const side = a.num.blockCells + 2 * a.num.apronCells;
    a.tiles.set(key, tile ? await decodeNumericTile(new Uint8Array(tile.data), side) : null);
  }
  const elev = a.tiles.get(key);
  out.push(elev ? { archive: a.id, ...cell, ...inspectNumericCell(elev, cell, a.num) } : null);
}
for (const a of archives.values()) await a.pm.source.fh?.close();
process.stdout.write(JSON.stringify(out));
