// Every external URL and provider switch (ARCHITECTURE 2 and 5.3). Change endpoints here, nowhere else.
// Relative URLs resolve against the page, so the app works under /colorado-ski-map/ or any subpath.

export const CONFIG = Object.freeze({
  appName: 'Skintrack CO',
  /** Bump when the shell changes so the service worker refreshes its cache. Keep in sync with sw.js. */
  version: '0.1.0',
  /** Berthoud, Jones and Loveland Pass pilot area (ARCHITECTURE 3.4). */
  initialView: {center: [-105.81, 39.75], zoom: 11.2},
  /** Colorado plus a small margin, [west, south, east, north]. Used for "outside Colorado" states. */
  coloradoBbox: [-109.10, 36.95, -102.00, 41.05],
  maxBounds: [-112.5, 34.5, -98.5, 43.5],

  basemap: {
    /** Lists the self-hosted Protomaps v4 archives (produced by the lead). */
    metaUrl: './data/basemap/basemap.meta.json',
    glyphs: './assets/glyphs/{fontstack}/{range}.pbf',
    sprite: './assets/sprite/light',
    attribution: '<a href="https://github.com/protomaps/basemaps">Protomaps</a> &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
  },

  /** Optional aerial imagery, online only (docs/sources/map-routes.md 4.4: public domain, ACAO *, max z16, data June 2024). */
  imagery: {
    tiles: 'https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer/tile/{z}/{y}/{x}',
    maxzoom: 16,
    attribution: 'Imagery: <a href="https://www.usgs.gov/programs/national-geospatial-program/national-map">USGS The National Map</a> orthoimagery (USDA, USGS)',
    note: 'USDA and USGS orthoimagery via The National Map, refreshed June 2024. Summer imagery: it shows tree cover and open slopes, not snow.'
  },

  /** Tier 1 DEM (ARCHITECTURE 3.3.1). All DEM tiles are Terrarium-encoded. Switch provider here. */
  terrain: {
    provider: 'mapterhorn',
    providers: {
      mapterhorn: {
        name: 'Mapterhorn', url: 'https://tiles.mapterhorn.com/{z}/{x}/{y}.webp', tileSize: 512, mime: 'image/webp',
        /** z13 at 512 px is about 7.3 m per pixel at 39.8 N; slope, hillshade and offline stop here. */
        maxzoom: 13,
        attribution: '<a href="https://mapterhorn.com/attribution">&copy; Mapterhorn</a>',
        sourceNote: 'USGS 3DEP 1 m and 1/3 arc-second plus Copernicus GLO-30, merged by Mapterhorn',
        /** Offline packages read the same tiles from Mapterhorn's limited-area download archives, never in bulk. */
        download: {low: 'https://download.mapterhorn.com/planet.pmtiles', lowMaxzoom: 12, high: 'https://download.mapterhorn.com/6-{x}-{y}.pmtiles'},
        docsUrl: 'https://mapterhorn.com/attribution'
      },
      aws: {
        name: 'AWS Terrain Tiles', url: 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png', tileSize: 256, mime: 'image/png',
        maxzoom: 14,
        attribution: '<a href="https://registry.opendata.aws/terrain-tiles/">Terrain Tiles</a> (USGS 3DEP and others)',
        sourceNote: 'Mapzen Terrain Tiles render (2017; pre-lidar USGS NED in Colorado)', download: null,
        docsUrl: 'https://github.com/tilezen/joerd/blob/master/docs/attribution.md'
      }
    }
  },

  /** Index of every static product. Each entry points at its *.meta.json. */
  manifestUrl: './data/manifest.json',

  /** Frequently refreshed products (SNODAS) are read first from the repo's data branch when hosted on
   *  <owner>.github.io/<repo>/, falling back to ./ (same pattern as the weather app's GEN_BASE). */
  generatedBase: (() => {
    const user = globalThis.location?.hostname.match(/^([^.]+)\.github\.io$/)?.[1];
    const repo = globalThis.location?.pathname.split('/').filter(Boolean)[0];
    return user && repo ? `https://raw.githubusercontent.com/${user}/${repo}/data/` : null;
  })(),
  snodasMetaPath: 'data/snow/snodas.meta.json',
  incidentLinksUrl: './data/incidents/official-links.json',

  /** Satellite-derived avalanche inventory, published by the avalanche-inventory app on the same origin. */
  sar: {
    /** Same origin once deployed; any origin serving the archives with CORS and Range works. */
    baseUrl: 'https://alecbiles-code.github.io/avalanche-inventory/',
    seasonal: 'all_seasons.pmtiles',
    hotspots: 'cross_season_hotspot.pmtiles',
    metaUrl: './data/sar/sar-inventory.meta.json',
    appUrl: 'https://alecbiles-code.github.io/avalanche-inventory/',
    repoUrl: 'https://github.com/alecbiles-code/avalanche-inventory'
  },

  /** Provider endpoints and switches. Permission-dependent integrations stay off until permission is documented. */
  providers: {
    caic: {enabled: false, product: {enabled: false}, api: 'https://api.avalanche.org/v2/public'},
    nws: {api: 'https://api.weather.gov', page: 'https://forecast.weather.gov/MapClick.php'},
    openMeteo: {api: 'https://api.open-meteo.com/v1/forecast', docs: 'https://open-meteo.com/en/docs', home: 'https://open-meteo.com/'},
    snotel: {api: 'https://wcc.sc.egov.usda.gov/awdbRestApi/services/v1', stationsUrl: './data/snow/snotel-stations.geojson',
      stationPage: 'https://wcc.sc.egov.usda.gov/nwcc/site'},
    officialLinks: {
      caicForecast: 'https://avalanche.state.co.us/',
      caicAccidents: 'https://avalanche.state.co.us/accidents/colorado',
      nws: 'https://www.weather.gov/'
    }
  },

  network: {timeoutMs: 15000, retries: 2},

  /** Bounds for untrusted imports (ARCHITECTURE 4.7, spec 18). */
  imports: {maxBytes: 5 * 1024 * 1024, maxFeatures: 2000, maxVertices: 200000, maxNameLength: 200, maxNoteLength: 4000},

  offline: {maxTiles: 30000, defaultMaxZoom: 14,
    /** Average bytes per tile for size estimates only; the result reports actual stored bytes. See docs/lanes/app-core.md. */
    avgTileBytes: {basemap: 6000, dem: 125000, t2num: 34000, overlay: 10000}}
});
