// MapLibre setup: tile path registration, contour source, style, controls.
import {CONFIG} from '../config.js';
import {buildStyle, CONTOUR_THRESHOLDS} from './style.js';
import {getTile, installProtocol, registerPmtiles, registerXyz} from './tiles.js';
import {fetchJson} from '../lib/net.js';
import {DEM, demDownloadArchive} from './terrain.js';

const maplibregl = globalThis.maplibregl;
let demSource = null;
let scaleCtl = null;

/** Load the basemap meta (list of archives). Returns null when the basemap is not available. */
async function loadBasemap() {
  try {
    const meta = await fetchJson(CONFIG.basemap.metaUrl);
    if (!Array.isArray(meta.archives) || !meta.archives.length) throw new Error('no archives listed');
    registerPmtiles('basemap', meta.archives, {tileType: 'vector'});
    return meta;
  } catch (err) {
    console.warn('basemap unavailable:', err.message);
    return null;
  }
}

/** maplibre-contour source whose DEM requests go through our tile path (offline first). */
function createDemSource() {
  const opts = {encoding: 'terrarium', maxzoom: DEM.maxzoom, cacheSize: 60, timeoutMs: CONFIG.network.timeoutMs};
  demSource = new globalThis.mlcontour.DemSource({...opts, url: 'dem://{z}/{x}/{y}', worker: false});
  // ponytail: contours are generated on the main thread so DEM bytes can come from IndexedDB; move to a worker if it janks.
  demSource.manager = new globalThis.mlcontour.LocalDemManager({...opts, demUrlPattern: 'dem://{z}/{x}/{y}',
    getTile: async (url, abort) => {
      const [z, x, y] = url.slice('dem://'.length).split('/').map(Number);
      const r = await getTile('dem', z, x, y, {signal: abort.signal});
      if (!r.data) throw new Error('DEM tile missing');
      return {data: new Blob([r.data], {type: DEM.mime})};
    }});
  demSource.setupMaplibre(maplibregl);
}

/** Contour tile URL for a unit system ('imperial' labels feet, 'metric' labels metres). */
export function contourUrl(units) {
  const metric = units === 'metric';
  return demSource.contourProtocolUrl({multiplier: metric ? 1 : 3.28084, thresholds: CONTOUR_THRESHOLDS[metric ? 'metric' : 'imperial'],
    elevationKey: 'ele', levelKey: 'level', contourLayer: 'contours', overzoom: 1});
}

/**
 * Create the map. Resolves once the style has loaded.
 * @param {HTMLElement} container
 * @param {string} units
 * @returns {Promise<{map: object, basemap: object|null}>}
 */
export async function createMap(container, units) {
  installProtocol(maplibregl);
  registerXyz('dem', DEM.url, {maxzoom: DEM.maxzoom, tileType: 'raster-dem', download: DEM.download ? demDownloadArchive : null});
  createDemSource();
  const basemap = await loadBasemap();
  const map = new maplibregl.Map({
    container, style: buildStyle({basemap, contourTiles: contourUrl(units)}),
    center: CONFIG.initialView.center, zoom: CONFIG.initialView.zoom, hash: 'map', maxBounds: CONFIG.maxBounds,
    maxPitch: 70, attributionControl: {compact: true}, localIdeographFontFamily: 'sans-serif',
    dragRotate: true, pitchWithRotate: false, cooperativeGestures: false, fadeDuration: 150
  });
  map.touchZoomRotate.enableRotation();
  scaleCtl = new maplibregl.ScaleControl({unit: units === 'metric' ? 'metric' : 'imperial', maxWidth: 110});
  map.addControl(scaleCtl, 'bottom-left');
  await new Promise(resolve => map.once('load', resolve));
  return {map, basemap};
}

/** Switch contour labels and scale bar between feet and metres. */
export function applyUnitsToMap(map, units) {
  map.getSource('contours')?.setTiles([contourUrl(units)]);
  scaleCtl?.setUnit(units === 'metric' ? 'metric' : 'imperial');
}

