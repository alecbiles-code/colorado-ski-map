// Untrusted route files: GPX and GeoJSON parsing, validation, bounds, and GPX/GeoJSON export.
// Pure (no DOM) so node tests cover it. Text is cleaned and bounded here and always rendered as text.
import {cleanText, escapeXml} from './escape.js';

const GEOM_TYPES = new Set(['Point', 'MultiPoint', 'LineString', 'MultiLineString', 'Polygon', 'MultiPolygon']);
const ENT = {lt: '<', gt: '>', amp: '&', quot: '"', apos: "'"};

export class ImportError extends Error {}

/** Decode the five XML entities and numeric character references; anything else stays literal. */
const decodeEntities = s => s.replace(/&(#x[0-9a-f]+|#\d+|lt|gt|amp|quot|apos);/gi, (m, e) => {
  if (e[0] !== '#') return ENT[e.toLowerCase()];
  const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
  return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : '';
});

/** Minimal XML tree parser for GPX: elements, attributes, text and CDATA. Rejects DOCTYPE (no entity expansion). */
export function parseXml(text) {
  if (/<!DOCTYPE/i.test(text)) throw new ImportError('GPX with a DOCTYPE is not accepted.');
  const re = /<!\[CDATA\[([\s\S]*?)\]\]>|<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<\/([\w:.-]+)\s*>|<([\w:.-]+)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)|(<)/g;
  const root = {name: '#root', attrs: {}, children: [], text: ''};
  const stack = [root];
  let m;
  while ((m = re.exec(text))) {
    const top = stack[stack.length - 1];
    if (m[1] !== undefined) top.text += m[1];
    else if (m[2]) {
      if (local(top.name) !== local(m[2])) throw new ImportError(`Malformed XML near </${m[2]}>.`);
      stack.pop();
    } else if (m[3]) {
      const attrs = {};
      for (const a of m[4].matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) attrs[local(a[1])] = decodeEntities(a[2] ?? a[3]);
      const node = {name: m[3], attrs, children: [], text: ''};
      top.children.push(node);
      if (!m[5]) stack.push(node);
    } else if (m[6] !== undefined) top.text += decodeEntities(m[6]);
    else if (m[7]) throw new ImportError('Malformed XML: stray "<".');
  }
  if (stack.length !== 1) throw new ImportError('Malformed XML: unclosed elements.');
  return root;
}
const local = n => n.replace(/^.*:/, '');
const kids = (n, name) => n.children.filter(c => local(c.name) === name);
const childText = (n, name) => kids(n, name)[0]?.text.trim() || '';

function point(n) {
  const lat = Number(n.attrs.lat); const lon = Number(n.attrs.lon);
  if (!(Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180)) throw new ImportError('GPX point with invalid lat/lon.');
  const ele = Number(childText(n, 'ele'));
  return childText(n, 'ele') !== '' && Number.isFinite(ele) ? [lon, lat, ele] : [lon, lat];
}

/** GPX text to a list of GeoJSON features (waypoints, routes, one feature per track). */
export function gpxToFeatures(text) {
  const gpx = kids(parseXml(text), 'gpx')[0];
  if (!gpx) throw new ImportError('Not a GPX file (no <gpx> element).');
  const props = (n, kind) => ({name: childText(n, 'name'), description: childText(n, 'desc') || childText(n, 'cmt'), kind});
  const out = [];
  for (const w of kids(gpx, 'wpt')) out.push({type: 'Feature', properties: props(w, 'waypoint'), geometry: {type: 'Point', coordinates: point(w)}});
  for (const r of kids(gpx, 'rte')) {
    const c = kids(r, 'rtept').map(point);
    if (c.length >= 2) out.push({type: 'Feature', properties: props(r, 'route'), geometry: {type: 'LineString', coordinates: c}});
  }
  for (const t of kids(gpx, 'trk')) {
    const segs = kids(t, 'trkseg').map(s => kids(s, 'trkpt').map(point)).filter(s => s.length >= 2);
    if (segs.length) out.push({type: 'Feature', properties: props(t, 'track'), geometry: segs.length === 1 ? {type: 'LineString', coordinates: segs[0]} : {type: 'MultiLineString', coordinates: segs}});
  }
  return out;
}

/** Validate one position; returns a clean [lon, lat] or [lon, lat, ele] array. */
function position(p) {
  if (!Array.isArray(p) || p.length < 2) throw new ImportError('Invalid coordinate.');
  const [lon, lat, ele] = p.map(Number);
  if (!(Number.isFinite(lon) && Number.isFinite(lat) && Math.abs(lon) <= 180 && Math.abs(lat) <= 90)) throw new ImportError('Coordinate out of range (GeoJSON order is lon, lat).');
  return Number.isFinite(ele) ? [lon, lat, ele] : [lon, lat];
}
const depth = {Point: 0, MultiPoint: 1, LineString: 1, MultiLineString: 2, Polygon: 2, MultiPolygon: 3};
function coords(c, d, count) {
  if (d === 0) { count.n += 1; return position(c); }
  if (!Array.isArray(c)) throw new ImportError('Invalid geometry.');
  return c.map(x => coords(x, d - 1, count));
}

/** GeoJSON text or object to a list of features with supported geometry types. */
export function geojsonToFeatures(obj) {
  const list = obj?.type === 'FeatureCollection' ? obj.features : obj?.type === 'Feature' ? [obj] : GEOM_TYPES.has(obj?.type) ? [{type: 'Feature', properties: {}, geometry: obj}] : null;
  if (!Array.isArray(list)) throw new ImportError('Not GeoJSON (expected a FeatureCollection, Feature or geometry).');
  return list.filter(f => f?.geometry && GEOM_TYPES.has(f.geometry.type)).map(f => ({type: 'Feature',
    properties: {name: f.properties?.name ?? f.properties?.title ?? '', description: f.properties?.description ?? f.properties?.desc ?? '', kind: 'imported'},
    geometry: {type: f.geometry.type, coordinates: f.geometry.coordinates}}));
}

/**
 * Parse and validate an imported file. Throws ImportError with a user-facing message.
 * @param {string} name file name; @param {string} text file contents; @param {object} limits CONFIG.imports
 * @returns {{type: 'FeatureCollection', features: object[]}}
 */
export function parseRouteFile(name, text, limits) {
  if (text.length > limits.maxBytes) throw new ImportError(`File is larger than ${Math.round(limits.maxBytes / 1048576)} MB.`);
  const lower = String(name).toLowerCase();
  let feats;
  if (lower.endsWith('.gpx') || /^\s*(<\?xml|<gpx)/.test(text)) feats = gpxToFeatures(text);
  else if (/\.(geo)?json$/.test(lower) || /^\s*[{[]/.test(text)) {
    let obj;
    try { obj = JSON.parse(text); } catch { throw new ImportError('File is not valid JSON.'); }
    feats = geojsonToFeatures(obj);
  } else throw new ImportError('Unsupported file type. Use .gpx, .geojson or .json.');
  if (!feats.length) throw new ImportError('No points, routes or tracks found in the file.');
  if (feats.length > limits.maxFeatures) throw new ImportError(`Too many features (${feats.length}; limit ${limits.maxFeatures}).`);
  const count = {n: 0};
  const out = feats.map(f => ({type: 'Feature', properties: {name: cleanText(f.properties.name, limits.maxNameLength), description: cleanText(f.properties.description, limits.maxNoteLength), kind: f.properties.kind},
    geometry: {type: f.geometry.type, coordinates: coords(f.geometry.coordinates, depth[f.geometry.type], count)}}));
  if (count.n > limits.maxVertices) throw new ImportError(`Too many points (${count.n}; limit ${limits.maxVertices}).`);
  return {type: 'FeatureCollection', features: out};
}

/** Export features as GPX 1.1 (points as waypoints, lines and polygon rings as tracks). */
export function toGpx(features, creator = 'Skintrack CO') {
  const meta = p => `${p.name ? `<name>${escapeXml(p.name)}</name>` : ''}${p.description ? `<desc>${escapeXml(p.description)}</desc>` : ''}`;
  // GPX 1.1 element order: ele before name and desc.
  const pt = (tag, c, extra = '') => `<${tag} lat="${c[1]}" lon="${c[0]}">${c.length > 2 ? `<ele>${c[2]}</ele>` : ''}${extra}</${tag}>`;
  const wpts = []; const trks = [];
  for (const f of features) {
    const g = f.geometry; const p = f.properties || {};
    if (g.type === 'Point') wpts.push(pt('wpt', g.coordinates, meta(p)));
    else if (g.type === 'MultiPoint') g.coordinates.forEach(c => wpts.push(pt('wpt', c, meta(p))));
    else {
      const segs = g.type === 'LineString' ? [g.coordinates] : g.type === 'MultiLineString' || g.type === 'Polygon' ? g.coordinates : g.coordinates.flat();
      trks.push(`<trk>${meta(p)}${segs.map(s => `<trkseg>${s.map(c => pt('trkpt', c)).join('')}</trkseg>`).join('')}</trk>`);
    }
  }
  return `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="${escapeXml(creator)}" xmlns="http://www.topografix.com/GPX/1/1">\n${[...wpts, ...trks].join('\n')}\n</gpx>\n`;
}

export const toGeojson = features => `${JSON.stringify({type: 'FeatureCollection', features}, null, 1)}\n`;
