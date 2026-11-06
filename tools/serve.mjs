// Local static server that mirrors GitHub Pages: serves the repo under /colorado-ski-map/ and honours
// single HTTP Range requests (PMTiles needs 206 responses). Usage: node tools/serve.mjs [port]
import {createServer} from 'node:http';
import {createReadStream, statSync} from 'node:fs';
import {extname, join, normalize, resolve, sep} from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const PREFIX = '/colorado-ski-map/';
const PORT = Number(process.argv[2] || process.env.PORT || 8790);
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.geojson': 'application/geo+json',
  '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp',
  '.jpg': 'image/jpeg', '.pbf': 'application/x-protobuf', '.pmtiles': 'application/octet-stream',
  '.bin': 'application/octet-stream', '.md': 'text/markdown; charset=utf-8', '.txt': 'text/plain; charset=utf-8'
};

/** Resolve a URL path to a file inside ROOT, or null when outside the prefix or the repo. */
function fileFor(urlPath) {
  if (!urlPath.startsWith(PREFIX)) return null;
  let rel = decodeURIComponent(urlPath.slice(PREFIX.length));
  if (rel === '' || rel.endsWith('/')) rel += 'index.html';
  const path = normalize(join(ROOT, rel));
  return path === ROOT || path.startsWith(ROOT + sep) ? path : null;
}

createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/colorado-ski-map') { res.writeHead(301, {Location: PREFIX}); return res.end(); }
  const path = fileFor(url.pathname);
  let st;
  try { st = path && statSync(path); } catch { st = null; }
  if (!st || !st.isFile()) { res.writeHead(404, {'Content-Type': 'text/plain'}); return res.end('Not found'); }
  const headers = {'Content-Type': TYPES[extname(path)] || 'application/octet-stream', 'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-cache', 'Access-Control-Allow-Origin': '*'};
  const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
  if (m && (m[1] || m[2])) {
    const start = m[1] ? Number(m[1]) : Math.max(0, st.size - Number(m[2]));
    const end = m[1] && m[2] ? Math.min(Number(m[2]), st.size - 1) : st.size - 1;
    if (start > end || start >= st.size) { res.writeHead(416, {'Content-Range': `bytes */${st.size}`}); return res.end(); }
    res.writeHead(206, {...headers, 'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Content-Length': end - start + 1});
    return req.method === 'HEAD' ? res.end() : createReadStream(path, {start, end}).pipe(res);
  }
  res.writeHead(200, {...headers, 'Content-Length': st.size});
  return req.method === 'HEAD' ? res.end() : createReadStream(path).pipe(res);
}).listen(PORT, () => console.log(`Serving ${ROOT} at http://localhost:${PORT}${PREFIX}`));
