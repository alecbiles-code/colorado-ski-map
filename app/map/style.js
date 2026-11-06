// Our topo style for the Protomaps v4 schema: generated basemap layers plus DEM hillshade and
// contours, with two invisible anchor layers that set render order for overlays:
//   anchor-terrain: raster overlays (slope, aspect, modeled terrain, snow) draw below roads and labels
//   anchor-overlay: vector overlays (routes, places, observations) draw above roads, below place labels
import {CONFIG} from '../config.js';
import basemapLayers from './basemap-layers.js';
import {absUrl} from './tiles.js';
import {DEM} from './terrain.js';

/** Contour intervals [minor, major] per zoom, in display units (feet or metres). */
export const CONTOUR_THRESHOLDS = {
  imperial: {11: [200, 1000], 12: [100, 500], 13: [40, 200], 14: [40, 200], 15: [20, 100]},
  metric: {11: [50, 250], 12: [50, 250], 13: [20, 100], 14: [10, 50], 15: [10, 50]}
};

const anchor = id => ({id, type: 'background', layout: {visibility: 'none'}, paint: {'background-color': '#000'}});

/** Hillshade and contour layers inserted between land cover and roads. */
function terrainLayers() {
  return [
    {id: 'hillshade', type: 'hillshade', source: 'dem', paint: {
      'hillshade-exaggeration': 0.45, 'hillshade-shadow-color': '#3d3526', 'hillshade-highlight-color': '#ffffff',
      'hillshade-accent-color': '#5a4f3c', 'hillshade-illumination-anchor': 'viewport'}},
    anchor('anchor-terrain'),
    {id: 'contours-minor', type: 'line', source: 'contours', 'source-layer': 'contours', minzoom: 11,
      filter: ['==', ['get', 'level'], 0],
      paint: {'line-color': '#8a5a2b', 'line-opacity': 0.45, 'line-width': ['interpolate', ['linear'], ['zoom'], 11, 0.4, 15, 0.9]}},
    {id: 'contours-major', type: 'line', source: 'contours', 'source-layer': 'contours', minzoom: 11,
      filter: ['>', ['get', 'level'], 0],
      paint: {'line-color': '#7a4a1d', 'line-opacity': 0.75, 'line-width': ['interpolate', ['linear'], ['zoom'], 11, 0.8, 15, 1.6]}}
  ];
}

const contourLabels = () => ({
  id: 'contours-label', type: 'symbol', source: 'contours', 'source-layer': 'contours', minzoom: 12,
  filter: ['>', ['get', 'level'], 0],
  layout: {'symbol-placement': 'line', 'text-field': ['number-format', ['get', 'ele'], {}], 'text-size': 11,
    'text-font': ['Noto Sans Regular'], 'text-max-angle': 30, 'symbol-spacing': 320},
  paint: {'text-color': '#6b3f17', 'text-halo-color': '#f4efe6', 'text-halo-width': 1.4}
});

/**
 * Lake and pond names. The Colorado extract carries them as `pois` of kind "water" (its lake polygons have no
 * names), and the generated `pois` layer does not list that kind, so without this layer no lake is ever named.
 */
const lakeLabels = () => ({
  id: 'water_label_pois', type: 'symbol', source: 'basemap', 'source-layer': 'pois',
  filter: ['all', ['==', ['get', 'kind'], 'water'], ['>=', ['zoom'], ['coalesce', ['get', 'min_zoom'], 0]]],
  layout: {'text-field': ['coalesce', ['get', 'name:en'], ['get', 'name'], ''], 'text-font': ['Noto Sans Italic'], 'text-size': 12, 'text-max-width': 8},
  paint: {'text-color': '#1d5f8a', 'text-halo-color': '#ffffff', 'text-halo-width': 1.2}
});

/**
 * Build the full style.
 * @param {{basemap: object|null, contourTiles: string}} opts basemap is the basemap meta (null if missing)
 */
export function buildStyle({basemap, contourTiles}) {
  const sources = {
    dem: {type: 'raster-dem', tiles: ['skt://tile/dem/{z}/{x}/{y}'], tileSize: DEM.tileSize, encoding: 'terrarium',
      maxzoom: DEM.maxzoom, attribution: DEM.attribution},
    contours: {type: 'vector', tiles: [contourTiles], maxzoom: 15}
  };
  let base = basemapLayers.filter(l => l.type === 'background');
  if (basemap) {
    sources.basemap = {type: 'vector', tiles: ['skt://tile/basemap/{z}/{x}/{y}'], minzoom: basemap.minzoom ?? 0,
      maxzoom: basemap.maxzoom ?? 14, bounds: basemap.bbox,
      attribution: basemap.sources?.[0]?.attribution || CONFIG.basemap.attribution};
    base = basemapLayers;
  }
  const firstRoad = base.findIndex(l => l.id.startsWith('roads_'));
  const firstSymbol = base.findIndex(l => l.type === 'symbol');
  const below = firstRoad >= 0 ? base.slice(0, firstRoad) : base;
  const roads = firstRoad >= 0 ? base.slice(firstRoad, firstSymbol >= 0 ? firstSymbol : undefined) : [];
  const labels = firstSymbol >= 0 ? [...base.slice(firstSymbol), lakeLabels()] : [];
  return {
    version: 8,
    glyphs: absUrl(CONFIG.basemap.glyphs),
    sprite: absUrl(CONFIG.basemap.sprite),
    sources,
    layers: [...below, ...terrainLayers(), ...roads, anchor('anchor-overlay'), contourLabels(), ...labels]
  };
}
