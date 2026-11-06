// Static check: every named import in app/ resolves to an existing file that exports that name. Usage: node tools/check-imports.mjs [repo root]
import {readFileSync, readdirSync, statSync, existsSync} from 'node:fs';
import {join, dirname, resolve} from 'node:path';
const root = process.argv[2] || new URL('..', import.meta.url).pathname;
const walk = d => readdirSync(d).flatMap(n => { const p = join(d, n); return statSync(p).isDirectory() ? walk(p) : [p]; });
const files = walk(join(root, 'app')).filter(f => f.endsWith('.js'));
const exportsOf = f => {
  const s = readFileSync(f, 'utf8'); const names = new Set();
  for (const m of s.matchAll(/export\s+(?:async\s+)?(?:function\*?|const|let|class)\s+([\w$]+)/g)) names.add(m[1]);
  for (const m of s.matchAll(/export\s*\{([^}]+)\}/g)) m[1].split(',').forEach(x => names.add(x.trim().split(/\s+as\s+/).pop()));
  if (/export\s+default/.test(s)) names.add('default');
  return names;
};
let bad = 0;
for (const f of files) {
  const s = readFileSync(f, 'utf8');
  for (const m of s.matchAll(/import\s+(?:(\w+)|\{([^}]*)\}|\*\s+as\s+\w+)?\s*(?:,\s*\{([^}]*)\})?\s*from\s*'([^']+)'/g)) {
    const target = resolve(dirname(f), m[4]);
    if (!existsSync(target)) { console.log(`MISSING FILE ${f} -> ${m[4]}`); bad++; continue; }
    const ex = exportsOf(target);
    const names = [m[2], m[3]].filter(Boolean).flatMap(x => x.split(',')).map(x => x.trim().split(/\s+as\s+/)[0]).filter(Boolean);
    if (m[1]) names.push('default');
    for (const n of names) if (!ex.has(n)) { console.log(`MISSING EXPORT ${f}: ${n} from ${m[4]}`); bad++; }
  }
}
console.log(bad ? `${bad} problems` : `ok: ${files.length} files`);
