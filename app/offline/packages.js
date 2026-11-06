// Offline packages: download a planned area into IndexedDB, track progress, cancel, resume after an
// interruption, validate against what was actually stored, and replace an older package only after the
// new one validates. Static data files go into the 'skintrack-data' cache the service worker serves.
import * as store from './store.js';
import {planTiles} from './planner.js';
import {getTile, setOfflineIndex} from '../map/tiles.js';

const DATA_CACHE = 'skintrack-data';
export const PACKAGE_VERSION = 1;

/** Load package records and feed complete or partial ones to the tile path. */
export async function setOfflineIndexFromStore() {
  const pkgs = await store.all('packages');
  // A package left "downloading" by a closed tab is interrupted, not complete.
  for (const p of pkgs.filter(x => x.status === 'downloading')) { p.status = 'interrupted'; await store.put('packages', p); }
  setOfflineIndex(pkgs.filter(p => p.status !== 'deleting').map(p => ({id: p.id, sources: p.plan.sets.map(s => s.id), bbox: p.bbox, minzoom: 0, maxzoom: 22})));
  return pkgs;
}

export const listPackages = () => store.all('packages');

/** Store static data files (manifest, metas, GeoJSON) in the data cache. Returns {ok, failed, bytes}. */
async function cacheFiles(urls) {
  const out = {ok: 0, failed: [], bytes: 0};
  if (!('caches' in globalThis)) return {...out, failed: urls};
  const cache = await caches.open(DATA_CACHE);
  for (const u of urls) {
    try {
      const res = await fetch(u, {cache: 'no-cache'});
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.clone().blob();
      await cache.put(u, res);
      out.ok += 1; out.bytes += blob.size;
    } catch { out.failed.push(u); }
  }
  return out;
}

/** Fetch one tile from the network and store it (an empty marker when the tile does not exist). */
async function fetchAndStore(pkgId, setId, z, x, y, signal) {
  const key = `${pkgId}|${setId}/${z}/${x}/${y}`;
  if (await store.hasKey('tiles', key)) return 'skipped';
  for (let attempt = 0; ; attempt++) {
    try {
      const r = await getTile(setId, z, x, y, {signal, offline: false, download: true});
      await store.put('tiles', r.data || new ArrayBuffer(0), key);
      return 'stored';
    } catch (err) {
      if (signal.aborted) throw err;
      if (err?.name === 'QuotaExceededError') throw err;
      if (attempt >= 2) return 'failed';
    }
  }
}

/**
 * Download (or resume) a package. Resolves with the final package record.
 * @param {object} pkg {id, name, plan, bbox, layers, files, sourceTimestamps, replaces?}
 * @param {{signal: AbortSignal, onProgress: (p: {done, total, failed}) => void}} opts
 */
export async function downloadPackage(pkg, {signal, onProgress}) {
  const rec = {...pkg, version: PACKAGE_VERSION, status: 'downloading', startedAt: pkg.startedAt || new Date().toISOString()};
  await store.put('packages', rec);
  const it = planTiles(rec.plan);
  const total = rec.plan.tiles;
  let done = 0; let failed = 0; let fatal = null;
  const worker = async () => {
    for (let n = it.next(); !n.done && !fatal; n = it.next()) {
      const [setId, z, x, y] = n.value;
      try {
        if (await fetchAndStore(rec.id, setId, z, x, y, signal) === 'failed') failed += 1;
      } catch (err) { fatal = err; return; }
      done += 1;
      if (done % 10 === 0 || done === total) onProgress?.({done, total, failed});
    }
  };
  await Promise.all(Array.from({length: 6}, worker));
  if (signal.aborted) fatal = null; // a cancel is an interruption, not an error
  const files = signal.aborted ? {ok: 0, failed: rec.files || [], bytes: 0} : await cacheFiles(rec.files || []);
  return finish(rec, {failed, fatal, files, aborted: signal.aborted});
}

/** Measure what was actually stored, set status, and drop the replaced package only when this one is complete. */
async function finish(rec, {failed, fatal, files, aborted}) {
  const m = await store.measurePrefix('tiles', `${rec.id}|`);
  const complete = !aborted && !fatal && failed === 0 && m.count === rec.plan.tiles && files.failed.length === 0;
  Object.assign(rec, {status: complete ? 'complete' : aborted ? 'interrupted' : 'partial', finishedAt: new Date().toISOString(),
    stored: {tiles: m.count, emptyTiles: m.empty, bytes: m.bytes + files.bytes, files: files.ok}, failedTiles: failed,
    failedFiles: files.failed, error: fatal ? String(fatal.message || fatal) : null});
  await store.put('packages', rec);
  if (complete && rec.replaces) await deletePackage(rec.replaces);
  await setOfflineIndexFromStore();
  return rec;
}

/** Delete a package's tiles and record. Cached data files are shared and stay. */
export async function deletePackage(id) {
  const p = await store.get('packages', id);
  if (p) await store.put('packages', {...p, status: 'deleting'});
  await setOfflineIndexFromStore();
  await store.delPrefix('tiles', `${id}|`);
  await store.del('packages', id);
  await setOfflineIndexFromStore();
}

/** Storage estimate and persistence state, where the browser supports them. */
export async function storageInfo() {
  const s = navigator.storage;
  const est = s?.estimate ? await s.estimate().catch(() => null) : null;
  const persisted = s?.persisted ? await s.persisted().catch(() => null) : null;
  return {usage: est?.usage ?? null, quota: est?.quota ?? null, persisted};
}
export const requestPersist = () => (navigator.storage?.persist ? navigator.storage.persist() : Promise.resolve(false));

