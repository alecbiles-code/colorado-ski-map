// Build data/manifest.json from every data/**/*.meta.json. Usage: node tools/gen-manifest.mjs [repo root]
import {readdirSync, readFileSync, statSync, writeFileSync} from 'node:fs';
import {join, relative} from 'node:path';

const root = process.argv[2] || new URL('..', import.meta.url).pathname;
const GROUP = {basemap: 'base', terrain: 'terrain', avalanche: 'avalanche', sar: 'history', incidents: 'history',
  routes: 'routes', places: 'routes', land: 'routes', coverage: 'routes', snow: 'snow', forecast: 'forecast', weather: 'weather'};
const walk = d => readdirSync(d).flatMap(n => { const p = join(d, n); return statSync(p).isDirectory() ? walk(p) : [p]; });
const products = [];
for (const p of walk(join(root, 'data')).filter(f => f.endsWith('.meta.json')).sort()) {
  let m;
  try { m = JSON.parse(readFileSync(p, 'utf8')); } catch (e) { console.error(`skip ${p}: ${e.message}`); continue; }
  const rel = relative(root, p);
  const dir = rel.split('/')[1];
  let url = (m.url || '').replace(/^\.\//, '') || null;
  if (!url) {
    const stem = p.replace(/\.meta\.json$/, '');
    const sib = ['.geojson', '.pmtiles', '.json'].map(e => stem + e).find(f => { try { return statSync(f).isFile(); } catch { return false; } });
    if (sib) url = relative(root, sib);
  }
  let bytes = m.bytes ?? null;
  if (bytes === null && url) { try { bytes = statSync(join(root, url)).size; } catch { /* remote or missing */ } }
  products.push({id: m.id || rel.replace(/\.meta\.json$/, ''), title: m.title || m.name || m.id || rel, group: GROUP[dir] || dir,
    kind: m.kind || null, url, meta: rel, bytes, bbox: m.bbox || m.coverage?.bbox || null, processedAt: m.processedAt || m.processing?.processedAt || null});
}
writeFileSync(join(root, 'data/manifest.json'), JSON.stringify({generatedAt: new Date().toISOString(),
  note: 'Index of static products. Regenerate when products change. Each entry points at its meta file.', products}, null, 1) + '\n');
console.log(products.map(p => `${p.group}\t${p.id}\t${p.kind}\t${p.url}\t${p.bytes}`).join('\n'));
