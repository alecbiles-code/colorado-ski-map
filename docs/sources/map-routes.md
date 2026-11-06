# Map, terrain, route, land and canopy sources

Lane: sources-map. Researched and tested 2026-11-06 between 00:03Z and 00:35Z (2026-11-05 17:03 to 17:35 America/Denver). All endpoint tests used keyless public access. Raw logs, downloaded pages and test scripts are in `/Users/bci-spatialecon/firstmate/data/colorado-ski-map-build/work/sources-map/` (`logs/`, `pages/`, `tools/`, `rangetest/`); they are not committed.

## 1. Method and vocabulary

1. HTTP tests: `curl` with `Origin: https://alecbiles-code.github.io`, recording status, `Access-Control-*`, `Content-Range`, `Content-Encoding`, `Cache-Control`, `Last-Modified`. Browser tests: headless Google Chrome 156.0.8078.80 and Playwright WebKit 27.2 (desktop and iPhone 15 profiles) loading a page on `http://127.0.0.1` and calling `fetch()`. WebKit here is Playwright's macOS build, not Safari on an iPhone.
2. Terms are quoted from the page named next to each quote, fetched at the time stated. A working URL is not treated as permission.
3. Status values: usable now, permission needed, technically blocked, incomplete, rejected. Route sources are also classified as reusable data, permission-dependent, or link-only.
4. Environment note: from about 00:28Z the sandbox lost system DNS and certificate trust for `curl`, Go and the browsers. Later `curl` calls used a pinned address (`--resolve` with an `nslookup` result); later browser tests were not possible. Items affected are marked untested.

## 2. Decision matrix

| # | Source | Role | Data license | Offline / redistribution | Browser access (tested) | Status |
|---|---|---|---|---|---|---|
| 1 | Protomaps daily build `20261105.pmtiles` (schema 4.15.2) | Basemap vector tiles | ODbL Produced Work (OSM) | Extract and self-host is the documented path | Origin has no CORS; served from our Pages origin instead | usable now |
| 2 | OpenFreeMap public tiles | Basemap alternative | ODbL (OSM), OpenMapTiles schema | Offline only if each download is at most 3,000 tiles or 50 MB and sends a unique User-Agent | ACAO `*`, MVT z0-14 | rejected (UA clause can't be met from a browser) |
| 3 | OSM standard tiles | none | ODbL data, tile policy | Offline and prefetch prohibited | not tested | rejected |
| 4 | USGS TNM USGSImageryOnly | Optional imagery | Public domain | No restrictions | ACAO `*`, JPEG, max z16 (z17 404) | usable now |
| 5 | USGS TNM USGSTopo, USGSShadedReliefOnly | Optional raster topo or relief | Public domain | No restrictions | ACAO `*`, JPEG, max z16 | usable now (not needed by default) |
| 6 | Esri World Imagery | none | Esri Master License Agreement | "not intended to be used to export tiles for offline" | ACAO `*` | rejected |
| 7 | USGS 3DEP 1/3 arc-second COG | Analytical terrain (Tier 2) | Public domain | No restrictions | ACAO `*`, 206 ranges, COG | usable now |
| 8 | USGS 3DEP 1 m DEM | Optional analytical refinement | Public domain | No restrictions | COG, 44 tiles and 5.2 GB over the pilot | usable now |
| 9 | AWS Terrain Tiles (Terrarium) | Visual terrain fallback | Public domain US source, attribution required | Open data | ACAO `*`, PNG 256 px, z0-15 | usable now (2017 render, pre-lidar here) |
| 10 | Mapterhorn | Visual terrain (recommended) | Per source: USGS public domain, Copernicus GLO-30 | Extracts documented; no stated policy for prefetching from the tile endpoint | ACAO `*`, WebP 512 px, z16 over pilot | usable now online; offline prefetch permission unclear |
| 11 | OSM via Geofabrik Colorado | Route geometry, trailheads, huts, peaks | ODbL | Redistribute with attribution; derived databases share-alike | PBF download (pipeline only) | usable now (reusable data) |
| 12 | OpenSkiData | Resort runs and lifts, normalized OSM pistes | ODbL plus credits | Download at most once per day; hosted tiles prohibited | metadata ACAO `*` | usable now (reusable data) |
| 13 | COTREX (CPW `CPWAdminData` layers 14, 15) | Trail allowed uses | No license grant | App terms forbid redistribution | ACAO `*`, GeoJSON or PBF query | permission needed |
| 14 | USFS `TrailNFS_Publish` | Designated SNOW trails on NFS land | Public domain | No access constraints | MapServer CORS echoes our origin | usable now (reusable data) |
| 15 | USFS MVUM, Over-Snow Vehicle Use Map | Motorized designations | Public domain | n/a | not tested | rejected as route source |
| 16 | 10th Mountain Division Hut Association | Hut pages, route GPX | Copyright, no license | Personal GPX download only | n/a | link-only |
| 17 | Friends of Berthoud Pass, CMC, SummitPost, Powder Project | Route beta | Copyright or restrictive terms | No | n/a | link-only |
| 18 | Beacon Guidebooks | Guidebook lines | Paid; onX membership | No dataset or license found | n/a | link-only (permission needed for content) |
| 19 | USGS GNIS Domestic Names, Colorado | Summits, gaps (passes) | Public domain, acknowledgment requested | No restrictions | ACAO `*`, 206 | usable now |
| 20 | PAD-US 4.1 | Land manager layer | Public domain | No restrictions | service CORS echoes our origin | usable now (recommended) |
| 21 | BLM Surface Management Agency | Federal manager alternative | BLM, public | Not verified | service CORS echoes our origin | incomplete (download not tested) |
| 22 | USFS Wilderness (EDW) | Wilderness boundaries | Public domain | No restrictions | CORS echoes our origin | usable now |
| 23 | NLCD Tree Canopy Cover v2025-6, year 2025 | Canopy input for avalanche model | Public domain | No restrictions | COG stored inside zip, range-readable | usable now (recommended) |
| 24 | USFS Science TCC v2025-6 | Unmasked canopy alternative | Public domain | No restrictions | COG in zip | usable now |
| 25 | LANDFIRE Forest Canopy Cover (LF 2025) | Canopy alternative | Not verified | Not verified | not tested | incomplete (researched only) |
| 26 | GitHub Pages (same origin) | Static host and PMTiles backend | n/a | n/a | 206, correct bytes from browsers | usable now |
| 27 | GitHub release assets | Tile backend | n/a | n/a | No CORS on redirect or target; browser fetch fails | technically blocked |
| 28 | Git LFS on Pages | Tile backend | n/a | n/a | Docs: "Git LFS cannot be used with GitHub Pages sites." | rejected |

## 3. Hosting: GitHub Pages limits and PMTiles behaviour

### 3.1 Current limits

Source: `https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits`, fetched 2026-11-06T00:05:50Z. Quotes: "Published GitHub Pages sites may be no larger than 1 GB." "GitHub Pages source repositories have a recommended limit of 1 GB." "GitHub Pages deployments will timeout if they take longer than 10 minutes." "GitHub Pages sites have a *soft* bandwidth limit of 100 GB per month." "GitHub Pages sites have a *soft* limit of 10 builds per hour. This limit does not apply if you build and publish your site with a custom GitHub Actions workflow." Rate limiting returns HTTP 429.

File sizes, from `https://docs.github.com/en/repositories/working-with-files/managing-large-files/about-large-files-on-github`: Git warns above 50 MiB; "If you add a file to a repository via a browser, the file can be no larger than 25 MiB."; "GitHub blocks files larger than 100 MiB." Repositories should ideally stay under 1 GB, and under 5 GB is "strongly recommended".

The contract's 25 MB per-file rule comes from the web-upload limit. If the captain deploys with `git push`, 50 MiB per file avoids warnings and halves the number of regional archives. Either way the 1 GB published-site cap is the binding budget.

### 3.2 Range test on an existing archive

`GET https://alecbiles-code.github.io/avalanche-inventory/all_seasons.pmtiles` with `Range: bytes=0-16383` and our Origin, 2026-11-06T00:03:13Z, curl sending no `Accept-Encoding`:

| Header | Value |
|---|---|
| Status | `206` |
| Content-Range | `bytes 0-16383/67200745` |
| Content-Encoding | absent |
| Content-Type | `application/octet-stream` |
| Access-Control-Allow-Origin | `*` (no `Expose-Headers`) |
| Cache-Control | `max-age=600` |
| Other | `accept-ranges: bytes`, `etag: "69a75b3a-40166e9"`, `vary: Accept-Encoding`, `last-modified: Tue, 03 Mar 2026 22:05:46 GMT` |

The body starts with `PMTiles` and version byte 3. `If-Range` with the ETag returns 206. `HEAD` returns 200 with the full length. `OPTIONS` returns 405, which doesn't matter: a single `bytes=` range is a CORS-safelisted header, and our app is same-origin.

### 3.3 Hazard: Pages applies ranges to the gzip representation

With `Accept-Encoding: gzip, deflate, br, zstd` (00:03:49Z), Pages returned `206`, `content-encoding: gzip` and `Content-Range: bytes 0-16383/66880581`. The total is the gzip length, and the body starts `1f 8b`. Those bytes are a slice of the compressed stream, not of the archive, so any client that advertises gzip on a range request gets corrupt PMTiles bytes. `Accept-Encoding: identity` returned correct bytes.

Browsers avoid this because the Fetch spec adds `Accept-Encoding: identity` to requests that carry `Range`. A logging test server confirmed it (00:04Z): Chrome 156 and WebKit 27.2 (desktop and iPhone profile) both sent `Accept-Encoding: identity` with `Range: bytes=0-15`. Both then fetched the real Pages archive with status 206, and the bytes began `504d54696c657303`.

Consequences:

1. The browser path is safe.
2. Pipeline and verification scripts must send `Accept-Encoding: identity` with ranges. Python `requests` sends gzip by default.
3. The Cache API can't store a 206 response, so offline packages need to store tiles or whole small archives in IndexedDB rather than caching range responses.

On a real iPhone this is untested; the evidence comes from Playwright WebKit.

### 3.4 Git LFS and release assets

1. Git LFS: "Git LFS cannot be used with GitHub Pages sites." (`about-git-large-file-storage` docs, fetched 00:06Z). It also wouldn't raise the 1 GB published-site cap. I did not test whether an Actions workflow that checks out LFS objects into the Pages artifact would serve them. Status: rejected.
2. Release assets (tested 00:06:07Z on `go-pmtiles-1.31.2_Darwin_arm64.zip`): `github.com` answers `302` without `Access-Control-Allow-Origin`. The target on `release-assets.githubusercontent.com` answers `206` with `Content-Range` but also no ACAO. Browser `fetch()` with `Range` failed in WebKit ("Load failed") and Chrome ("Failed to fetch") at 00:06:19Z. Release docs: "Each file included in a release must be under 2 GiB. There is no limit on the total size of a release, nor bandwidth usage." Status: technically blocked as a browser tile backend. Usable for pipeline downloads only.

## 4. Basemap

### 4.1 Protomaps daily builds

Landing page: `https://docs.protomaps.com/basemaps/downloads`, read from `https://raw.githubusercontent.com/protomaps/docs/main/basemaps/downloads.md`. Build index: `https://build-metadata.protomaps.dev/builds.json`. Data: `https://build.protomaps.com/20261105.pmtiles`.

**The build.** Size 139,339,872,322 bytes, uploaded 2026-11-05T09:02:51Z, version 4.15.2. `pmtiles show` reports MVT z0-15, gzip tile compression, `planetiler:osm:osmosisreplicationtime 2026-11-05T04:00:00Z`, and attribution `© OpenStreetMap`. At 00:07:09Z the origin returned 206 to a range request without an ACAO header, so it's not usable from the browser directly. That doesn't matter, because we extract it.

**Terms.** Quoted from `basemaps/downloads.md`:

> "distributed as an Open Database License Produced Work (OpenStreetMap attribution required)"

> "Please note that URLs may change and hotlinking to these downloads are discouraged. Instead, you should copy the tileset to your own Cloud Storage."

> "To download a cutout of a specific region, rather than the entire world map, see the CLI's extract command."

`pmtiles extract` is therefore the intended, documented way to take a regional copy.

**Measured extract sizes.** `pmtiles extract --dry-run`, go-pmtiles 1.31.2, Colorado bbox `-109.06,36.99,-102.04,41.01`, 00:07:53Z:

| maxzoom | Archive size |
|---|---|
| 12 | 55 MB |
| 13 | 122 MB |
| 14 | 250 MB |
| 15 | 520 MB |

The pilot box `-106.00,39.58,-105.62,39.92` at z15 is 4.4 MB.

**Schema.** Layers: `boundaries`, `buildings`, `earth`, `landcover`, `landuse`, `places`, `pois`, `roads`, `transit`, `water`. Roads include kinds `path` and `aerialway`, with `kind_detail` `track` and `path`. POIs include `peak`. Landuse includes `forest`, `glacier`, `bare_rock`, `national_park` and `protected_area`. Piste tags are not in the schema.

**Separate licenses.**

1. Software: go-pmtiles BSD-3-Clause, `pmtiles` JS 4.5.0 BSD-3-Clause, `@protomaps/basemaps` 5.7.2 BSD-3-Clause (npm, checked 00:07Z). The downloads doc says tiles v4 are "compatible with `@protomaps/basemaps` style v4.0.0 and newer".
2. Style visual design: "released under a Creative Commons 0 (CC0) license" (`protomaps/basemaps` LICENSE.md).
3. Data: ODbL (OSM and osmdata.openstreetmap.de), plus Natural Earth (public domain). ESA WorldCover (CC BY 4.0) applies only if the `landcover` layer is displayed.
4. Glyphs and sprites (`protomaps/basemaps-assets` README): "`fonts/`: SIL Open Font License" (Noto Sans), "`sprites/`: derived from MIT-licensed tangrams/icons".

Hosted tiles are our own copy, so no third-party tile terms apply. Required attribution: "© OpenStreetMap", with a link to `https://www.openstreetmap.org/copyright`. The OSM copyright page adds: "Make clear that the data is available under the Open Database License."

**Refresh.** Daily builds. The bucket retains "All builds for the past week" and "The latest build for each patch version", so pin a build date in config and re-extract deliberately.

### 4.2 OpenFreeMap

Sources: `https://openfreemap.org/tos/` ("Last Updated: October 14, 2026") and `https://openfreemap.org/`, fetched 00:08:30Z.

> "You will not: ... Collect data from the service in automated ways, except for offline downloads as described below"

> "Your app may let users download areas for offline use if each download is: at most 3,000 tiles or 50 MB; made with at most 4 parallel requests; sent with a unique User-Agent identifying your app. For anything larger, please contact us at info@openfreemap.org."

**Test.** `https://tiles.openfreemap.org/planet` returned 200 with ACAO `*`. The tile URL is `https://tiles.openfreemap.org/planet/20261101_080013_pt/{z}/{x}/{y}.pbf`, maxzoom 14. Tile 12/842/1551 returned 200, ACAO `*`, `cache-control: max-age=315360000`.

**Assessment.** A browser PWA can't set a custom User-Agent, so the offline clause can't be met from the app. It's also a third-party runtime dependency. Rejected as default and as offline source. Weekly planet MBTiles downloads exist but weren't evaluated, because Protomaps already covers self-hosting.

### 4.3 OSM standard tiles

Source: `https://operations.osmfoundation.org/policies/tiles/`, fetched 00:08:31Z.

> "Offline use is not permitted on tile.openstreetmap.org. Features such as 'Download city/country for offline use' or 'Save area for later' rely on prefetch/bulk downloading and are therefore prohibited."

> "If you require offline maps, use self-hosted tiles or a provider that explicitly allows offline/prefetching."

Confirmed: not an offline source. Rejected.

### 4.4 USGS The National Map basemap services

Endpoints: `https://basemap.nationalmap.gov/arcgis/rest/services/{USGSTopo|USGSImageryOnly|USGSShadedReliefOnly}/MapServer/tile/{z}/{y}/{x}`.

**Tested** 00:09:10Z at Berthoud Pass, tiles z14 `6214/3377` and z16 `24858/13511`:

1. All three services return 200, `image/jpeg`, `access-control-allow-origin: *`, `cache-control: max-age=86400`.
2. z17 returns 404 on all three, so the effective max zoom is 16 (`maxScale` 9027.98).
3. Service JSON reports `exportTilesAllowed: true`, `maxExportTilesCount: 100000`.

**Data age** (copyright text, 00:08:53Z):

1. USGSTopo: "Data refreshed September 4, 2026".
2. USGSImageryOnly: "USDA, USGS The National Map: Orthoimagery. Data refreshed June, 2024."
3. USGSShadedReliefOnly: "Data refreshed September, 2025."

**Terms.** `https://www.usgs.gov/faqs/what-are-terms-uselicensing-map-services-and-data-national-map` (00:09:26Z):

> "Map services and data downloaded from The National Map are free and in the public domain. There are no restrictions; however, we request that the following acknowledgment statement of the originating agency be included in products and data derived from our map services when citing, copying, or reprinting: 'Map services and data available from U.S. Geological Survey, National Geospatial Program.'"

**Offline caching.** Public domain with "no restrictions" permits caching. The `exportTilesAllowed` flag is only a technical signal. Bounded area packages should still be kept modest so the service isn't loaded heavily. I found no stated uptime commitment. Status: usable now.

### 4.5 Esri World Imagery

Item `10df2279f9684e4a9f6a7f08febac2a9` `licenseInfo`, read 00:09:50Z via `https://www.arcgis.com/sharing/rest/content/items/10df2279f9684e4a9f6a7f08febac2a9?f=json`:

> "This work is licensed under the Esri Master License Agreement." "Export: This layer is not intended to be used to export tiles for offline. If you would like to export imagery for offline use in ArcGIS applications, you may use the World Imagery (for Export) layer, which is intended for this purpose."

The export item `226d23f076da478bba4589e7eae95952`: "This item requires an ArcGIS Online organizational subscription or an ArcGIS Developer account".

Service JSON: `exportTilesAllowed: false`. Rejected: offline is not permitted outside ArcGIS apps, and an account is required.

## 5. Terrain

### 5.1 USGS 3DEP 1/3 arc-second

TNM Access query (00:10:00Z): `https://tnmaccess.nationalmap.gov/api/v1/products?datasets=National Elevation Dataset (NED) 1/3 arc-second&bbox=-106.5,39.5,-105.5,39.9`.

**Current files** (tested 00:10:06Z):

| Tile | URL | Last-Modified | Size | Published (TNM) |
|---|---|---|---|---|
| n40w106 | `https://prd-tnm.s3.amazonaws.com/StagedProducts/Elevation/13/TIFF/current/n40w106/USGS_13_n40w106.tif` | 2026-07-02 | 413,480,184 B | 2026-07-01 (`USGS_13_n40w106_20260630`) |
| n40w107 | `https://prd-tnm.s3.amazonaws.com/StagedProducts/Elevation/13/TIFF/current/n40w107/USGS_13_n40w107.tif` | 2026-07-08 | 425,389,234 B | 2026-07-08 (`USGS_13_n40w107_20260708`) |

Earlier versions remain under `.../historical/`. For n40w106 these are dated 2011-06-01, 2022-02-16, 2023-06-02, 2026-03-23, 2026-05-28 and 2026-06-30.

**Browser access.** Range request returned `206`, `Access-Control-Allow-Origin: *`, `Access-Control-Allow-Methods: GET, HEAD`, `Content-Type: image/tiff`.

**Format** (header read via ranges). GDAL COG layout `LAYOUT=IFDS_BEFORE_DATA`, 10812 x 10812 px (1 degree plus a 6 px buffer), 512 px tiles, LZW, float32, NoData `-999999`, five overviews.

**Metadata** (`USGS_13_n40w106.xml`): NAD83 horizontal, NAVD88 vertical, metres, pixel 9.259259e-05 degrees (about 7.1 m east-west by 10.3 m north-south at 39.8 N).

> "There is no guarantee or warranty concerning the accuracy of the data."

Access constraints: "None."

**Source lineage.** From the tile's source-footprint GeoPackage `USGS_13_n40w106.gpkg`. Area shares are computed in degrees, so they are approximate. Pilot box `-106.00,39.58,-105.62,39.92`:

| Lidar project | Share | Collected | Published |
|---|---|---|---|
| CO_DRCOG_2020_B20 | 66.1% | 2020-21 | 2022-02-17 |
| CO_ArapahoRooseveltPikeNF_D23 | 24.6% | 2023 | 2026-03-23 |
| CO_Central_and_WesternCO_2016_A16 | 9.4% | 2016 | 2018-04-05 |

So the pilot box is entirely lidar-derived. The whole n40w107 tile still has small areas built from 1950s to 1980s non-lidar sources (`LT4X`, `LT2000`, each at or below about 1.2%).

The pilot box lies in n40w106. Its west edge, -106.00, is the tile boundary. The UTM analysis grid may cross into n40w107 slightly, so the terrain lane should read both tiles.

**License.** Public domain. Requested credit: "Data available from U.S. Geological Survey, National Geospatial Program."

### 5.2 USGS 3DEP 1 m DEM and lidar

TNM Access over the pilot box (00:11:00Z):

1. 44 one-metre DEM tiles, totalling 5,201,114,488 bytes. They come from four projects with publication dates 2020-03-30 (13 "USGS one meter" 2016 tiles), 2022-02-10 (16 DRCOG 2020), 2026-03-20 (12 ARP NF 2023) and 2026-05-28 (3 Park/Fremont/Custer 2018). Overlapping projects mean some areas have more than one tile.
2. Example: `https://prd-tnm.s3.amazonaws.com/StagedProducts/Elevation/1m/Projects/CO_DRCOG_2020_B20/TIFF/USGS_1M_13_x41y439_CO_DRCOG_2020_B20.tif`. It's a COG, 10012 x 10012 px with 1 m pixels, UTM zone 13, 512 px tiles, LZW, float32, NoData `-999999`.
3. "Seamless 1-m DEM (S1M)": 0 products over the pilot.
4. Lidar point cloud (LPC): 2115 files.

Over the Colorado bounding box the API reports 4565 one-metre products and 316 1/3-arc-second products. Those counts include neighbouring states and overlaps, so they don't measure coverage.

### 5.3 AWS Terrain Tiles (Terrarium)

Endpoint: `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png`. Tested 00:11:46Z over Berthoud Pass, 39.7983, -105.7772:

| Tile | Status | `x-amz-meta-x-imagery-sources` | Last-Modified |
|---|---|---|---|
| z12 844/1553 | 200 | `ned13/USGS_NED_13_n40w106_IMG.tif` | Sun, 12 Nov 2017 01:34:41 GMT |
| z13 1688/3107 | 200 | `ned13/USGS_NED_13_n40w106_IMG.tif` | 12 Nov 2017 |
| z14 3377/6214 | 200 | `ned13/USGS_NED_13_n40w106_IMG.tif` | 12 Nov 2017 |
| z15 6755/12429 | 200 | `ned13/USGS_NED_13_n40w106_IMG.tif` | 12 Nov 2017 |
| z16 13511/24858 | 404 | n/a | n/a |

Headers include `Access-Control-Allow-Origin: *` and `Access-Control-Expose-Headers: x-amz-meta-x-imagery-sources`.

The tiles were rendered in November 2017 from the then-current NED 1/3 arc-second IMG. All three lidar sources now in the current tile were published after that date (2018-04-05, 2022-02-17 and 2026-03-23), so the Terrain Tiles here can't contain them.

Registry entry (`awslabs/open-data-registry/datasets/terrain-tiles.yaml`): "UpdateFrequency: New data is added based on community feedback". License points to `https://github.com/tilezen/joerd/blob/master/docs/attribution.md`, which requires, among others: "United States 3DEP (formerly NED) and global GMTED2010 and SRTM terrain data courtesy of the U.S. Geological Survey."

### 5.4 Mapterhorn

Sources: `https://mapterhorn.com/`, `/data-access/`, `/attribution/` (00:12:05Z), `https://download.mapterhorn.com/attribution.json`.

**Format.** "Terrarium-encoded terrain rgb tiles as webp images with 512 pixel width", bundled into PMTiles: `planet.pmtiles` for z0-12, and per-z6 archives for z13+. Colorado falls in `6-12-24`, `6-13-24` and `6-14-24` (z13-16).

**Endpoint test** (00:12:23Z). `https://tiles.mapterhorn.com/{z}/{x}/{y}.webp` returns 200, ACAO `*`, `cache-control: public, max-age=604800` at z12, z14 and z16 over Berthoud; z17 returns 404. `https://download.mapterhorn.com/6-13-24.pmtiles` returned a 206 range response with ACAO `*` (87,698,656,865 bytes, Last-Modified 2026-09-11).

The endpoint returned 403 to the default Python `urllib` User-Agent and 200 to curl and to a descriptive User-Agent. Pipeline scripts must set an identifying User-Agent.

**Colorado sources** (`attribution.json`):

1. `us1aa` through `us1ma`: "1 meter Digital Elevation Models (DEMs) - USGS National Map 3DEP", "Public Domain (U.S. Government Work)", access year 2026.
2. `usgs3dep13`: 1/3 arc-second, public domain, access year 2025.
3. `glo30`: Copernicus GLO-30, "COPERNICUS full, free and open license".

Over the pilot box, 29 of the 44 TNM 1 m tiles appear in Mapterhorn's source file lists. The 13 2016 tiles and 16 DRCOG 2020 tiles are present. The 2023 Arapaho-Roosevelt-Pike and 2018 Park/Fremont/Custer tiles are absent. Which source fills those gaps is not stated per tile.

**License.** "Code: BSD-3", "Terrain data: various open-data sources, for a full list see https://mapterhorn.com/attribution". Required display attribution: "© Mapterhorn" linking to the attribution page.

**Offline.** No terms or usage policy for `tiles.mapterhorn.com` were found; the only policy page is the privacy policy, which logs IP, referrer and user agent for 30 days. Extracts are documented ("Download Mapterhorn data extracts for a limited area"). Measured extract sizes:

| Extract | Size |
|---|---|
| Colorado, z0-11 | 163 MB |
| Colorado, z0-12 | 596 MB |
| Colorado, z13 only | about 1.0 GB |
| Pilot box, z13-16 | 948 MB |

Statewide self-hosting above z11 doesn't fit the 1 GB Pages budget.

### 5.5 Measured accuracy against current 3DEP

`tools/terrain_compare.py`, 00:15:30Z. For four z14 tiles around Berthoud Pass, each 256 x 256 tile pixel (about 7.3 m) was compared by nearest-neighbour sampling against current `USGS_13_n40w106.tif`. Mapterhorn z13 512 px tiles were cropped to the same footprint.

| z14 tile | AWS - 3DEP RMSE / p95 / max (m) | Mapterhorn - 3DEP RMSE / p95 / max (m) |
|---|---|---|
| 3377/6214 | 5.59 / 11.22 / 27.83 | 1.70 / 3.67 / 16.58 |
| 3376/6214 | 7.80 / 15.78 / 35.21 | 1.43 / 3.06 / 11.28 |
| 3377/6215 | 7.44 / 16.56 / 35.53 | 1.91 / 4.07 / 10.12 |
| 3378/6213 | 8.49 / 17.17 / 35.70 | 1.81 / 3.78 / 12.81 |

AWS bias was +1.6 to +4.9 m; Mapterhorn bias was -0.4 to +0.8 m. Both used the same resampling, so the AWS gap reflects its older source, not the method. This is an elevation comparison only. Slope effects are left to the terrain lane's Tier 1 vs Tier 2 comparison.

## 6. Routes, access and destinations

### 6.1 OpenStreetMap via Geofabrik (reusable data)

`https://download.geofabrik.de/north-america/us/colorado.html` (00:16:00Z): `colorado-latest.osm.pbf`, "contains all OSM data up to 2026-11-03T21:24:23Z. File size: 369 MB."

License, from `https://www.openstreetmap.org/copyright`:

> "You are free to copy, distribute, transmit and adapt our data, as long as you credit OpenStreetMap and its contributors. If you alter or build upon our data, you may distribute the result only under the same license."

Our route database derived from OSM is therefore ODbL. Keep it a separate product from any non-ODbL layer.

Ski-relevant tags in Colorado, counted with Overpass (`overpass-api.de`, OSM base 2026-11-06T00:15:14Z):

| Tag | Count |
|---|---|
| `piste:type=downhill` | 3968 ways |
| `piste:type=nordic` | 2112 ways and 73 relations |
| `piste:type=fatbike` | 145 |
| `piste:type=hike` (snowshoe or winter hike) | 103 ways and 9 relations |
| `piste:type=skitour` | 47 ways, plus 4 `skitour;nordic` |
| `piste:type=snowshoe` | 26 |
| `piste:type=uphill` | 5 |
| `piste:type=backcountry` | 2 |
| `piste:grooming=backcountry` | 697 features, 447 of them `piste:type=downhill` |
| `route=ski` | 3 |
| `ski=*` | 301 |
| `snowshoe=*` | 65 |
| `natural=peak` | 3746 (3462 named) |
| `mountain_pass=yes` | 158 |
| `natural=saddle` | 188 |
| `highway=trailhead` | 562 |
| `tourism=alpine_hut` or `wilderness_hut` | 66 |
| `snowmobile=*` | 297 |
| `highway=path` | 60622 ways |

`piste:type=downhill` combined with `piste:grooming=backcountry` is how named backcountry descents are mapped in Colorado. Examples include "Mt. Harvard South Face", "Angel of Shavano (Snow Route)" and "North Maroon Peak Northeast Ridge", alongside approach roads tagged `skitour`. Coverage is sparse and clustered around Aspen, Maroon Bells and the Sawatch. The routes lane owns the regional audit.

### 6.2 OpenSkiData / OpenSkiMap (reusable data)

Source: `https://openskidata.org/`, fetched 00:19:13Z. Terms:

> "The data is rebuilt daily. Automated downloading is permitted at most once per day. Direct use of the vector tiles at tiles.openskimap.org is not permitted. Build and host your own tiles from these files instead."

> "The formats are not stable."

> "The data is free to use, including commercially. It is derived from OpenStreetMap and is therefore available under the Open Database License (ODbL): if you distribute a modified version of the data, you must share it alike."

Ready-made attribution: "Data from OpenSkiData / OpenSkiMap.org, © OpenStreetMap contributors (ODbL), Skimap.org, Who's On First, © Mapterhorn".

Exports are GeoJSON, CSV and a GeoPackage at `https://tiles.openskimap.org/{geojson,csv}/{ski_areas,runs,lifts,spots}.*` and `https://tiles.openskimap.org/openskidata.gpkg`.

`metadata.json` (00:19:20Z) returned 200 with ACAO `*`. It reports OSM data timestamp 2026-11-04T01:00Z, format 16.0.0, 230,794 runs, and a runs GeoJSON of 838,494,560 bytes.

Feature IDs "are not stable between daily builds". Use the upstream OSM ID instead.

I did not download the exports, to leave the once-per-day allowance to the routes lane. Skimap.org's own license was not found; OpenSkiData's page covers the export.

### 6.3 COTREX (permission-dependent)

**App terms.** `https://trails.colorado.gov/terms` ("Last Update: October 25, 2018", fetched 00:19:34Z), under Restrictions on Use, "you may not":

> "Use, repost, copy, distribute or publish any Content unless you have been given permission by Colorado Parks and Wildlife in a separate written agreement;"

> "Use geographic location data to create or augment any other data set;"

**Public data service.** `https://services5.arcgis.com/ttNGmDvKQA7oeDQ3/ArcGIS/rest/services/CPWAdminData/FeatureServer`, layer 15 "COTREX Trails" and layer 14 "COTREX Trailheads". Tested 00:20:21Z:

1. ACAO `*`; query formats JSON, geoJSON and PBF; 2000 records per page.
2. 83,008 features. The layer description still says "last updated on 2/5/2019", but the maximum `EDIT_DATE` is 2026-04-06.
3. Winter attributes: `ski`, `snowshoe`, `snowmobile`, `groomed`, `groomer_ur`, `plowed`, `seasonalit`.
4. Counts: `ski='yes'` 3958, `snowshoe='yes'` 3796, `snowmobile='yes'` 1906. Most features have a blank `ski`, and a few contain date ranges.

These are allowed-use flags. They are not winter routes or skin tracks. Examples in the pilot box include summer trails and county roads.

**Item license.** `licenseInfo`, item `168fccb0583f42f1afe57de6c9ce846d`:

> "This map is a product and property of the Colorado Parks and Wildlife ... ANY DATA OR INFORMATION PROVIDED BY THE DEPARTMENT OF NATURAL RESOURCES IS PROVIDED 'AS IS'".

There is no license grant.

**CPW GIS page.** `https://cpw.state.co.us/maps-and-gis` (00:19:59Z):

> "This data allows outdoor enthusiasts, researchers, app developers and conservationists to analyze trends and make informed decisions and custom products."

That invites use but doesn't grant redistribution, and it conflicts with the app terms.

**What would unlock it.** Written confirmation from the CPW GIS Unit that the `CPWAdminData` COTREX layers may be redistributed as a static derived product with attribution. Until then: no COTREX geometry in committed data, and a link to `https://trails.colorado.gov/`. Layer 2 "CPW Trail Segments" (state-park trails) has the same owner and the same status.

### 6.4 USFS datasets

**Correct dataset.** "National Forest System Trails", `TrailNFS_Publish`, from `https://data.fs.usda.gov/geodata/edw/datasets.php` (00:20:55Z). Shapefile `https://data.fs.usda.gov/geodata/edw/edw_resources/shp/Trans_Trail_NFS_Publish.zip` (248,837,686 B, Last-Modified 2026-11-02), file geodatabase `.../fc/Trans_Trail_NFS_Publish.gdb.zip`, service `https://apps.fs.usda.gov/arcx/rest/services/EDW/EDW_TrailNFSPublish_01/MapServer`. The service echoes our origin in ACAO with credentials.

**Fields.** `trail_type` (TERRA, SNOW, WATER), `allowed_snow_use`, and `*_managed`, `*_accpt` and `*_restricted` date ranges for `xcountry_ski`, `snowshoe` and `snowmobile`. The metadata code list for `allowed_snow_use`: "1 Snowshoe", "2 Cross-country ski", "3 Snowmobile".

**Colorado bbox counts** (00:21:19Z):

| Query | Segments |
|---|---|
| All | 6571 |
| `trail_type='SNOW'` | 345 |
| `xcountry_ski_managed` not null | 207 |
| `snowmobile_managed` not null | 173 |

Pilot examples: BAKERVILLE-LOVELAND (SNO-60.1), LEAP FROG (SNOW), ST. LOUIS LOOP.

**Terms** (metadata `Trans_Trail_NFS_Publish.xml`): access constraints "None". Use constraints are a no-warranty disclaimer. This is a US government work and counts as reusable data.

**Not route sources.** MVUM Trails ("Forest Service trails where motorized use is allowed") and the Over-Snow Vehicle Use Map are motorized designation products. No over-snow dataset appears in the EDW list (grep for "over-snow", "OSV"). OSVUM could later mark snowmobile-open areas for context, but it is not a ski route source.

### 6.5 County and open-space GIS

Not evaluated individually. The COTREX layer description says its trails "come from a variety of sources (USFS, BLM, local parks & recreation departments, local governments)". Local open-space portals carry summer trails, not ski lines. Revisit only if a specific county publishes winter-route data with an open license.

### 6.6 Hut, club and guidebook sources (link-only)

1. **10th Mountain Division Hut Association** (`https://huts.org/`, 00:21:38Z). Hut pages carry coordinates, for example Jackal Hut "39.438282, -106.277618", plus winter route descriptions and per-route "Download .GPX" links. Footer: "© 2026 10th Mountain Division Hut Association"; no license found. Classification: link-only. Hut points come from OSM `tourism=wilderness_hut` or `alpine_hut` (66 in Colorado). Users may download huts.org GPX themselves and import it locally; it is never committed.
2. **Friends of Berthoud Pass** (`https://www.berthoudpass.org/`). "© Friends of Berthoud Pass 2026". Its "Skiing Guidebook" link goes to the paid Beacon atlas. Link-only.
3. **Colorado Mountain Club** (`https://www.cmc.org/legal/terms-conditions`, 00:22:33Z). The license "excludes: ... (c) the distribution, public performance or public display of any Site Content; (d) modifying or otherwise making any derivative uses ... (e) use of any data mining, robots or similar data gathering or extraction methods". Link-only.
4. **SummitPost.** The terms page returned 403 to curl and WebFetch (00:21:44Z), so it was not verified. User content is copyrighted by contributors. Link-only.
5. **Powder Project** (onX Maps, `https://www.adventureprojects.net/ap-terms`, 00:21:58Z). The license is "for your personal, non-commercial use only" and prohibits "spiders, crawlers, robots, scrapers". Link-only.
6. **Beacon Guidebooks** (`https://beaconguidebooks.com/onx-backcountry-app/`, 00:21:39Z). "Beacon Guidebooks has partnered with onX Backcountry ... This partnership pairs thousands of Beacon ski lines ... with onX's conditions data". The Berthoud atlas page says: "Content is also synced with the onX Backcountry App (membership required)." No public dataset, API or redistribution license was found. Link-only. Any guidebook text, photos or line geometry needs Beacon's explicit written permission.

## 7. Names: USGS GNIS

File: `https://prd-tnm.s3.amazonaws.com/StagedProducts/GeographicNames/DomesticNames/DomesticNames_CO_Text.zip` (1,136,591 B, Last-Modified 2026-11-02, metadata pubdate 20261102). Tested 00:22:42Z: 206 with ACAO `*`.

**Format.** Pipe-delimited text with columns `feature_id`, `feature_name`, `feature_class`, `prim_lat_dec`, `prim_long_dec`, and others. Coordinates are NAD83 decimal degrees.

**Counts.** 26,429 names in total. Summit 3214, Gap 339 (passes and saddles), Ridge 371, Basin 296, Cliff 220, Pillar 142.

**Terms** (metadata):

> "Use constraints: None. Acknowledgment of the U.S. Geological Survey would be appreciated for products derived from these data."

Status: usable now, reusable data. Preserve `feature_id` as the upstream ID.

## 8. Land status

### 8.1 PAD-US 4.1 (recommended)

Download page: `https://www.usgs.gov/programs/gap-analysis-project/science/pad-us-data-download` (00:23:13Z): "The latest version of the Protected Areas Database of the U.S. (PAD-US 4.1) is now available."

Colorado file, from ScienceBase item `6759abcfd34edfeb8710a004` ("PAD-US 4.1 State Downloads", publication date 2025-03-31): `PADUS4_1_State_CO_GDB_KMZ.zip`, 167,859,434 B. The download itself was not tested.

**Service.** `https://edits.nationalmap.gov/arcgis/rest/services/PAD-US/PAD_US_4_1/MapServer/0` (`PADUS4_1Fee`). It echoes our origin in ACAO. Fields include `Mang_Type`, `Mang_Name`, `Own_Type`, `Des_Tp`, `Unit_Nm`, `Pub_Access`, `GAP_Sts` and `Src_Date`.

**Terms** (service metadata, 00:23Z):

> "These data are in the public domain."

> "Agencies are always the official and best source of their land data and some update more frequently than PAD-US."

> "The FGDC Federal Lands Working Group recommends the use of PAD-US to describe federally managed lands (i.e., 'Manager Name' not 'Owner Name')".

Citation: "U.S. Geological Survey (USGS) Gap Analysis Project (GAP), 2024, Protected Areas Database of the United States (PAD-US) 4.1: U.S. Geological Survey data release, https://doi.org/10.5066/P96WBCHS."

### 8.2 BLM Surface Management Agency (incomplete)

Service: `https://gis.blm.gov/arcgis/rest/services/lands/BLM_Natl_SMA_LimitedScale/MapServer`, tested 00:28:03Z with a pinned address. Returns 200 and echoes our origin in ACAO. The description says it "classifies this land by its active Federal surface managing agency". Layers cover each federal agency plus State, Local, and Private or Unknown.

The national download ("BLM National SMA Surface Management Agency Area Polygons", catalog.data.gov) was found by search but not tested. It classifies by federal manager only, without unit names or access, so PAD-US is preferred.

### 8.3 USFS Wilderness

`https://data.fs.usda.gov/geodata/edw/edw_resources/shp/BdyDesg_LSRS_Wilderness.zip`, 27,604,378 B, Last-Modified 2026-11-02. Service `EDW_Wilderness_01`; 37 polygons intersect the Colorado bounding box (00:33:31Z). Public domain. Wilderness matters for skiing because mechanized travel is prohibited there.

PAD-US `Des_Tp` already carries wilderness designations across agencies. Use this layer only if a sharper USFS boundary is wanted.

### 8.4 Display rule

Land-manager polygons show who manages the surface. They don't show current access, closures, easement terms, winter road status or legal parking. The inspector must say so and link to the managing unit.

## 9. Canopy

### 9.1 NLCD Tree Canopy Cover v2025-6 (recommended)

Landing page: `https://data.fs.usda.gov/geodata/rastergateway/treecanopycover/` (version 2025.6, 1985-2025). MRLC lists the same product (published Oct 13, 2026).

**2025 CONUS files** (00:32:06Z):

| File | URL | Size | Last-Modified |
|---|---|---|---|
| NLCD TCC | `https://data.fs.usda.gov/geodata/rastergateway/treecanopycover/docs/v2025-6/nlcd_tcc_conus_2025_v2025-6_wgs84.zip` | 3,598,621,213 B | 2026-04-30 |
| Science TCC | `.../science_tcc_conus_2025_v2025-6_wgs84.zip` | 6,253,582,556 B | n/a |
| Science standard error | `.../science_se_conus_2025_v2025-6_wgs84.zip` | 18,307,089,122 B | n/a |

**Format** (zip directory and metadata read with range requests, `tools/remote_zip.py`). The GeoTIFF `nlcd_tcc_conus_wgs84_v2025-6_20250101_20251231.tif` is stored uncompressed inside the zip (method 0) and is a COG (`LAYOUT=IFDS_BEFORE_DATA`). GDAL `/vsizip//vsicurl/` can therefore read a Colorado window without downloading 3.6 GB; this was not run.

**CRS.** Albers Conic Equal Area (latitude of center 23, longitude of center -96, standard parallels 29.5 and 45.5) on the WGS 84 datum, not EPSG:5070. Byte, DEFLATE, 30 m.

**Semantics** (metadata):

> "TCC pixel values range from 0 to 100 percent. The non-processing area is represented by value 254, and the background is represented by the value 255."

The methods report (`TCC_v2025-6_Methods.pdf`, October 2026, p. 9) defines canopy as "The vertically-projected polygon described by the outline of the foliage, ignoring any normal spaces occurring between the leaves of plants", and percent tree canopy cover as "The percent of systematically arranged points (109 total) within a 144-foot radius circle centered on an FIA plot that fall over tree canopy".

The NLCD version masks water and non-tree crops to 0, zeroes low-confidence urban pixels, and filters interannual changes under 10%. The Science version is unmasked.

Accuracy (p. 26): "The 2011 CONUS-wide NLCD TCC map weighted RMSE is 13 percent TCC, and the weighted MAE is 8 percent TCC."

**License** (metadata): "The goal of this project is to provide CONUS and OCONUS with complete, current and consistent public domain tree canopy cover information." The landing page carries only a no-warranty disclaimer.

**Semantics for the avalanche-model lane:**

1. The value is percent canopy cover (projected crown area fraction times 100), 0 to 100.
2. It is not stem density (stems per hectare), basal area, or a binary forest mask.
3. Treat 254 and 255 as NoData (unknown), never as 0. A value of 0 is a valid, possibly masked, zero.
4. If a model needs binary forest, derive it with an explicit, documented threshold.
5. Resampling 30 m to the 10 m grid must use nearest neighbour or an explicitly documented method, and must keep NoData.

### 9.2 LANDFIRE Forest Canopy Cover (alternative, researched only)

`https://landfire.gov/fuel/cc`, via WebFetch summary at 00:30Z, not quoted verbatim. CC "describes the percent cover of the tree canopy in a stand". At non-disturbed locations it takes the midpoint of the Existing Vegetation Cover forested classes, adjusted for disturbance. It covers forested areas only and is designed for fire-behaviour modelling. The latest CONUS release is LF 2025.

The class-midpoint encoding is coarser than TCC's continuous percent and can't be mixed with it. Not tested. License text was not found on the page.

## 10. Recommendations

1. **Basemap.**
   1. Self-host a Protomaps extract of build `20261105`, schema 4.15.2, at statewide maxzoom 14 (measured 250 MB). Split it into regional PMTiles archives, each at or below the contract's 25 MB limit: about 11 files, or 6 at the 50 MiB git-push threshold. MapLibre overzooms z14 vector tiles for close views. If the 1 GB site budget is tight, maxzoom 13 (122 MB) is the fallback.
   2. Use our own style, optionally built from `@protomaps/basemaps` 5.7.2 (BSD-3). Self-host Noto Sans glyphs (OFL) and the sprites (MIT).
   3. Attribution: "Protomaps © OpenStreetMap", with links to `https://www.openstreetmap.org/copyright` and the ODbL.
   4. Do not use OSM standard tiles, the OpenFreeMap public endpoint, or Esri imagery for offline.
   5. Optional imagery layer: USGS `USGSImageryOnly`. It is public domain, NAIP-based ("Data refreshed June, 2024"), CORS `*`, max z16, and allows bounded offline packages. Credit: "Map services and data available from U.S. Geological Survey, National Geospatial Program."
2. **Terrain tiers.**
   1. Visual tier: Mapterhorn live tiles (Terrarium WebP, 512 px, z16 where USGS 1 m sources exist). Measured RMSE against current 3DEP was 1.4 to 1.9 m, versus 5.6 to 8.5 m for AWS Terrain Tiles. AWS tiles over the pilot are a November 2017 render that predates all of the area's lidar. Keep AWS Terrain Tiles as the configured fallback provider. This changes architecture section 3.3.1 and needs the lead to amend the contract.
   2. Offline terrain: Mapterhorn publishes no usage policy for the tile endpoint. Until one permits bounded offline prefetch, offline packages should use the self-hosted Tier 2 products where they exist, and otherwise AWS Terrain Tiles (open data).
   3. Analytical tier: current USGS 3DEP 1/3 arc-second COGs, as in the contract. Over the pilot they are 100% lidar-derived (2016, 2020-21 and 2023 collections), public domain, NAD83/NAVD88, metres, COG with CORS. The 1 m DEM (44 tiles, 5.2 GB over the pilot) is optional, for validating the 10 m products.
3. **Routes.**
   1. Primary reusable geometry: OSM (Geofabrik daily PBF, ODbL). Use `piste:type=skitour|hike|snowshoe|nordic`, `piste:grooming=backcountry`, `route=ski`, `highway=trailhead`, `tourism=wilderness_hut|alpine_hut`, `natural=peak`, `mountain_pass=yes` and `natural=saddle`.
   2. Add OpenSkiData for resort context. Download at most once per day, build our own tiles, never use its hosted tiles.
   3. Add USFS `TrailNFS_Publish` SNOW-type trails as designated winter trails (public domain).
   4. Add GNIS summits and gaps for search.
   5. COTREX is permission needed: link only, and its `ski` flag is an allowed use, not a route.
   6. huts.org, Friends of Berthoud Pass, CMC, SummitPost, Powder Project and Beacon are link-only. Users may import their own GPX locally.
   7. Keep OSM-derived (ODbL) and other-licensed products as separate files.
4. **Land layer.** PAD-US 4.1, Colorado state download, public domain. Show `Mang_Name`, `Mang_Type`, `Des_Tp`, `Unit_Nm` and `Pub_Access`, label it "manager, not access or parking status", and link to the managing agency. USFS Wilderness is an optional sharper overlay. BLM SMA is not needed.
5. **Canopy input.** NLCD TCC v2025-6, year 2025: percent canopy cover 0-100, 30 m, Albers on WGS 84; 254 and 255 are NoData. Read the Colorado window with `/vsizip//vsicurl/`. Use Science TCC only if the model wants unmasked values. The avalanche-model lane must match its input semantics: canopy fraction, not stem density or binary. Any threshold must be explicit and documented, and NoData must stay unknown.

## 11. Untested and open items

1. Real iPhone Safari range behaviour on Pages. Evidence so far is Playwright WebKit 27.2 only.
2. Browser decode of Mapterhorn WebP and a browser fetch of the USGS imagery. CORS headers were verified with curl; the browser runs failed after the sandbox change.
3. Mapterhorn pilot extract size below z16. Dry-runs failed after the sandbox lost DNS and TLS.
4. Downloads not run: PAD-US Colorado zip, BLM SMA download, OpenSkiData exports (left to the routes lane), NLCD TCC Colorado window read.
5. Skimap.org license and SummitPost terms (403) are not verified.
6. LANDFIRE CC was read via a summary only.
