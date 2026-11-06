// Pure geographic helpers: Web Mercator tile math, bboxes, distances. Coordinates are [lon, lat].
// bbox is [west, south, east, north] in degrees.

const R_EARTH = 6371008.8; // mean Earth radius in metres (IUGG), for great-circle distances

export const lon2x = (lon, z) => Math.floor(((lon + 180) / 360) * 2 ** z);
export function lat2y(lat, z) {
  const r = (Math.max(-85.0511, Math.min(85.0511, lat)) * Math.PI) / 180;
  return Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z);
}
export const x2lon = (x, z) => (x / 2 ** z) * 360 - 180;
export function y2lat(y, z) {
  const n = Math.PI - (2 * Math.PI * y) / 2 ** z;
  return (180 / Math.PI) * Math.atan(Math.sinh(n));
}

/** Geographic bbox of tile z/x/y. */
export const tileBbox = (z, x, y) => [x2lon(x, z), y2lat(y + 1, z), x2lon(x + 1, z), y2lat(y, z)];

/** Fractional tile coordinates of a point (for pixel sampling inside a tile). */
export function lonLatToTileFrac(lon, lat, z) {
  const r = (lat * Math.PI) / 180;
  return [((lon + 180) / 360) * 2 ** z, ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z];
}

/** Tile index range [xmin, ymin, xmax, ymax] (inclusive) covering bbox at zoom z. */
export function tileRange(bbox, z) {
  const max = 2 ** z - 1;
  const clamp = v => Math.max(0, Math.min(max, v));
  return [clamp(lon2x(bbox[0], z)), clamp(lat2y(bbox[3], z)), clamp(lon2x(bbox[2] - 1e-9, z)), clamp(lat2y(bbox[1] + 1e-9, z))];
}

/** Number of tiles covering bbox for each zoom in [minz, maxz]. */
export function countTiles(bbox, minz, maxz) {
  let n = 0;
  for (let z = minz; z <= maxz; z++) {
    const [x0, y0, x1, y1] = tileRange(bbox, z);
    n += (x1 - x0 + 1) * (y1 - y0 + 1);
  }
  return n;
}

/** Generate [z, x, y] for every tile covering bbox in [minz, maxz], low zooms first. */
export function* enumerateTiles(bbox, minz, maxz) {
  for (let z = minz; z <= maxz; z++) {
    const [x0, y0, x1, y1] = tileRange(bbox, z);
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) yield [z, x, y];
  }
}

export const bboxIntersects = (a, b) => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1];
export const bboxContains = (b, [lon, lat]) => lon >= b[0] && lon <= b[2] && lat >= b[1] && lat <= b[3];
export const bboxIntersection = (a, b) => [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.min(a[2], b[2]), Math.min(a[3], b[3])];

/** Great-circle distance in metres between two [lon, lat] points. */
export function distanceM([lon1, lat1], [lon2, lat2]) {
  const t = Math.PI / 180;
  const dLat = (lat2 - lat1) * t; const dLon = (lon2 - lon1) * t;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * t) * Math.cos(lat2 * t) * Math.sin(dLon / 2) ** 2;
  return 2 * R_EARTH * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Ray-casting point in polygon for a single ring of [lon, lat]. */
export function pointInRing([px, py], ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]; const [xj, yj] = ring[j];
    if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Point in a GeoJSON Polygon or MultiPolygon geometry (holes respected). */
export function pointInGeometry(pt, geom) {
  if (!geom) return false;
  const polys = geom.type === 'Polygon' ? [geom.coordinates] : geom.type === 'MultiPolygon' ? geom.coordinates : [];
  return polys.some(rings => pointInRing(pt, rings[0]) && !rings.slice(1).some(h => pointInRing(pt, h)));
}

/** Bbox of any GeoJSON geometry or feature collection. Returns null when there are no coordinates. */
export function geojsonBbox(obj) {
  const b = [Infinity, Infinity, -Infinity, -Infinity];
  const walk = c => {
    if (typeof c[0] === 'number') {
      b[0] = Math.min(b[0], c[0]); b[1] = Math.min(b[1], c[1]); b[2] = Math.max(b[2], c[0]); b[3] = Math.max(b[3], c[1]);
    } else c.forEach(walk);
  };
  const visit = g => {
    if (!g) return;
    if (g.type === 'FeatureCollection') g.features.forEach(f => visit(f.geometry));
    else if (g.type === 'Feature') visit(g.geometry);
    else if (g.type === 'GeometryCollection') g.geometries.forEach(visit);
    else if (g.coordinates) walk(g.coordinates);
  };
  visit(obj);
  return Number.isFinite(b[0]) ? b : null;
}

/** Length in metres of a line of [lon, lat] (or [lon, lat, ele]) positions. */
export const lineLengthM = coords => coords.reduce((s, c, i) => (i ? s + distanceM(coords[i - 1], c) : 0), 0);

/** Parse "39.75, -105.8" or "-105.8 39.75" style input into [lon, lat], or null. Accepts N/S/E/W suffixes. */
export function parseCoordinates(text) {
  const m = String(text).trim().match(/^(-?\d+(?:\.\d+)?)\s*°?\s*([NSEW])?[\s,;]+(-?\d+(?:\.\d+)?)\s*°?\s*([NSEW])?$/i);
  if (!m) return null;
  let a = Number(m[1]); let b = Number(m[3]);
  const ha = (m[2] || '').toUpperCase(); const hb = (m[4] || '').toUpperCase();
  if (ha === 'S' || ha === 'W') a = -Math.abs(a);
  if (hb === 'S' || hb === 'W') b = -Math.abs(b);
  // Order: explicit hemisphere letters win; otherwise "lat, lon" unless the first value cannot be a latitude.
  let lat; let lon;
  if (ha === 'E' || ha === 'W' || hb === 'N' || hb === 'S') [lon, lat] = [a, b];
  else if (Math.abs(a) > 90) [lon, lat] = [a, b];
  else [lat, lon] = [a, b];
  if (!(Math.abs(lat) <= 90 && Math.abs(lon) <= 180)) return null;
  return [lon, lat];
}
