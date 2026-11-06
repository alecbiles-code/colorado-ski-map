// Browser smoke pass for the app shell, one command, rerunnable. Drives a real Chromium with puppeteer-core.
// Usage:
//   node tests/harness/smoke.mjs <baseUrl> <outDir> --modules <dir with node_modules/puppeteer-core> --chrome <executable> [--arg <chrome flag>]...
// Example (local server from tools/serve.mjs on 8791):
//   node tests/harness/smoke.mjs http://localhost:8791/colorado-ski-map/ ./shots --modules work/headless --chrome .../chrome-headless-shell
// Writes screenshots and report.json (steps, console errors, failed requests, overflow checks) into outDir.
// Exit code 1 when any step fails, a page error occurs, or horizontal overflow is found.
import {createRequire} from 'node:module';
import {mkdirSync, writeFileSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const argv = process.argv.slice(2);
const opt = name => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : null; };
const extraArgs = argv.flatMap((a, i) => (a === '--arg' ? [argv[i + 1]] : []));
const [base, outDir] = argv.filter((a, i) => !a.startsWith('--') && !argv[i - 1]?.startsWith('--'));
if (!base || !outDir || !opt('modules') || !opt('chrome')) {
  console.error('usage: node tests/harness/smoke.mjs <baseUrl> <outDir> --modules <dir> --chrome <executable> [--arg <flag>]...');
  process.exit(2);
}
const puppeteer = createRequire(join(resolve(opt('modules')), 'package.json'))('puppeteer-core');
const GPX = fileURLToPath(new URL('./fixtures/sample.gpx', import.meta.url));
mkdirSync(outDir, {recursive: true});

const report = {base, startedAt: new Date().toISOString(), steps: [], consoleErrors: [], pageErrors: [], failedRequests: [], overflow: []};
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function step(name, fn) {
  const t0 = Date.now();
  try { const detail = await fn(); report.steps.push({name, ok: true, ms: Date.now() - t0, detail: detail ?? null}); console.log(`ok   ${name}`); }
  catch (err) { report.steps.push({name, ok: false, ms: Date.now() - t0, error: String(err?.message || err)}); console.log(`FAIL ${name}: ${err?.message || err}`); }
}

function watch(page, label) {
  page.on('console', m => { if (m.type() === 'error') report.consoleErrors.push({label, text: m.text(), url: m.location()?.url}); });
  page.on('pageerror', e => report.pageErrors.push({label, text: String(e?.message || e)}));
  page.on('requestfailed', r => report.failedRequests.push({label, url: r.url(), error: r.failure()?.errorText}));
}

const shot = (page, name) => page.screenshot({path: join(outDir, `${name}.png`)});
const click = (page, sel) => page.$eval(sel, el => el.click());
async function noOverflow(page, label) {
  const o = await page.evaluate(() => ({sw: document.documentElement.scrollWidth, w: window.innerWidth,
    wide: [...document.querySelectorAll('body *')].filter(e => e.getBoundingClientRect().right > window.innerWidth + 1 && getComputedStyle(e).position !== 'fixed' && e.offsetParent).slice(0, 5).map(e => e.className || e.tagName)}));
  if (o.sw > o.w) report.overflow.push({label, ...o});
  return o;
}
/** Wait until the map exists, its style loaded and it reports idle (or the timeout passes). */
const mapIdle = (page, ms = 20000) => page.evaluate(ms => new Promise(res => {
  const t = setTimeout(() => res('timeout'), ms);
  const go = () => { const m = globalThis.__skintrack?.map; if (!m) return setTimeout(go, 200); if (m.loaded()) { clearTimeout(t); res('idle'); } else m.once('idle', () => { clearTimeout(t); res('idle'); }); };
  go();
}), ms);
const sheetText = page => page.$eval('#sheet-body', el => el.innerText.slice(0, 600));
const jump = (page, lon, lat, zoom) => page.evaluate((lon, lat, zoom) => globalThis.__skintrack.map.jumpTo({center: [lon, lat], zoom}), lon, lat, zoom);

async function mobile(browser) {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  watch(page, 'mobile');
  await page.emulate({viewport: {width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true},
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'});
  await step('mobile: load and map idle', async () => { await page.goto(base, {waitUntil: 'load'}); return mapIdle(page); });
  await step('mobile: default map screenshot and no overflow', async () => { await jump(page, -105.79, 39.78, 13); await mapIdle(page); await shot(page, 'm01-map'); return noOverflow(page, 'map'); });
  await step('mobile: layers panel opens with groups', async () => { await click(page, '#btn-layers'); await sleep(400); await shot(page, 'm02-layers'); return page.$$eval('#sheet-body section h3', h => h.map(x => x.textContent)); });
  await step('mobile: slope on (Tier 1 + Tier 2 pilot)', async () => {
    await page.$eval('[data-layer="slope"] input[type=checkbox]', el => el.click()); await mapIdle(page); await sleep(800);
    await click(page, '#sheet-close'); await sleep(300); await shot(page, 'm03-slope');
    return page.$eval('#chips', el => el.innerText);
  });
  await step('mobile: tap inspector shows terrain with tier', async () => {
    const box = await page.$eval('#map', el => { const r = el.getBoundingClientRect(); return [r.width / 2, r.height / 2]; });
    await page.touchscreen.tap(box[0], box[1] - 80); await sleep(4000); await shot(page, 'm04-inspector');
    return sheetText(page);
  });
  await step('mobile: conditions view keeps the selection', async () => { await click(page, '.tab[data-view="conditions"]'); await sleep(3000); await shot(page, 'm05-conditions'); return page.$eval('#sheet-title', e => e.textContent); });
  await step('mobile: explore lists nearby routes', async () => { await click(page, '.tab[data-view="explore"]'); await sleep(2500); await shot(page, 'm06-explore'); return sheetText(page); });
  await step('mobile: search by name', async () => {
    await click(page, '.tab[data-view="map"]');
    await page.type('#search-input', 'Berthoud'); await sleep(1500); await shot(page, 'm07-search');
    const n = await page.$$eval('#search-results li[role=option]', l => l.length);
    await page.keyboard.press('Enter'); await sleep(2500); await shot(page, 'm08-search-selected');
    return {results: n, hash: await page.evaluate(() => location.hash)};
  });
  await step('mobile: search by coordinates', async () => {
    await page.$eval('#search-input', el => { el.value = ''; }); await page.type('#search-input', '39.7984, -105.7771'); await sleep(500);
    return page.$eval('#search-results', el => el.innerText);
  });
  await step('mobile: overlays on (routes, places, SNOTEL, SAR, SNODAS)', async () => {
    await page.keyboard.press('Escape');
    await page.evaluate(async () => { const r = globalThis.__skintrack.reg; for (const id of ['routes', 'places', 'snotel', 'sar-seasonal', 'snodas-depth']) await r.setOn(id, true); });
    await jump(page, -105.78, 39.79, 12.5); await mapIdle(page); await sleep(1500); await shot(page, 'm09-overlays');
    return page.evaluate(() => Object.fromEntries([...globalThis.__skintrack.reg.state].filter(([, s]) => s.on).map(([k, s]) => [k, `${s.status} ${s.detail}`])));
  });
  await step('mobile: saved import GPX, list, export buttons', async () => {
    await click(page, '.tab[data-view="saved"]'); await sleep(800);
    const input = await page.$('#sheet-body input[type=file]'); await input.uploadFile(GPX); await sleep(1500); await shot(page, 'm10-saved');
    const txt = await sheetText(page);
    if (!/Synthetic test track/.test(txt)) throw new Error('imported track not listed');
    if (await page.$('#sheet-body b')) throw new Error('imported markup was rendered as HTML');
    return txt;
  });
  await step('mobile: sources and methods', async () => { await page.evaluate(() => [...document.querySelectorAll('#sheet-body button')].find(b => b.textContent === 'Sources and methods').click()); await sleep(1500); await shot(page, 'm11-sources'); return sheetText(page); });
  await step('mobile: no horizontal overflow in sheets', async () => noOverflow(page, 'sources'));
  await step('mobile: offline download, then reload with the network blocked', async () => {
    await jump(page, -105.777, 39.798, 13.5); await mapIdle(page);
    await click(page, '.tab[data-view="saved"]'); await sleep(800);
    await page.evaluate(() => [...document.querySelectorAll('#sheet-body button')].find(b => b.textContent === 'Use current view').click());
    await page.evaluate(() => [...document.querySelectorAll('#sheet-body .seg button')].find(b => b.textContent === 'z13').click());
    await sleep(300);
    await page.evaluate(() => [...document.querySelectorAll('#sheet-body button')].find(b => b.textContent === 'Download this area').click());
    await page.waitForFunction(() => /Complete:|Incomplete:|Cancelled:|Download stopped/.test(document.querySelector('#sheet-body').innerText), {timeout: 240000});
    await shot(page, 'm12-offline-done');
    const result = await page.$eval('#sheet-body', el => (el.innerText.match(/(Complete|Incomplete|Download stopped)[^\n]*/) || [''])[0]);
    await page.setOfflineMode(true);
    await page.reload({waitUntil: 'load'}); await mapIdle(page, 30000); await sleep(2000); await shot(page, 'm13-offline-reload');
    const chips = await page.$eval('#chips', el => el.innerText);
    await page.setOfflineMode(false);
    return {result, chips};
  });
  await ctx.close();
}

async function desktop(browser) {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  watch(page, 'desktop');
  await page.setViewport({width: 1280, height: 900});
  await step('desktop: load, layers side panel, place card', async () => {
    await page.goto(`${base}#map=13/39.79/-105.78`, {waitUntil: 'load'}); await mapIdle(page);
    await click(page, '#btn-layers'); await sleep(500); await shot(page, 'd01-layers');
    await page.mouse.click(900, 450); await sleep(3500); await shot(page, 'd02-place');
    return noOverflow(page, 'desktop');
  });
  await ctx.close();
}

const browser = await puppeteer.launch({executablePath: opt('chrome'), headless: true,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', ...extraArgs]});
try { await mobile(browser); await desktop(browser); } finally { await browser.close(); }
report.finishedAt = new Date().toISOString();
writeFileSync(join(outDir, 'report.json'), JSON.stringify(report, null, 1));
const failed = report.steps.filter(s => !s.ok).length;
console.log(`${report.steps.length - failed}/${report.steps.length} steps ok; ${report.consoleErrors.length} console errors; ${report.pageErrors.length} page errors; ${report.overflow.length} overflow`);
process.exit(failed || report.pageErrors.length || report.overflow.length ? 1 : 0);
