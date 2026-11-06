# Lane notes: sources-map

Deliverable: `docs/sources/map-routes.md` (matrix, per-source notes, recommendations). Work files (not committed): `/Users/bci-spatialecon/firstmate/data/colorado-ski-map-build/work/sources-map/`. That folder holds `logs/` (raw headers, dry-runs, comparisons), `pages/` (fetched terms pages), `tools/` (scripts), `rangetest/` (browser range harness) and `bin/pmtiles` (go-pmtiles 1.31.2). Tests ran 2026-11-06 00:03Z to 00:35Z.

## 1. Findings that affect other lanes

1. **App core, GitHub Pages ranges.** Pages applies byte ranges to the gzip representation whenever the client sends `Accept-Encoding: gzip`. The response then carries a gzip total in `Content-Range` (66880581 instead of 67200745) and corrupt bytes. Chrome 156 and WebKit 27.2 send `Accept-Encoding: identity` with `Range`, so the browser path tested correct (206, PMTiles magic). Pipeline and verification scripts must send `Accept-Encoding: identity`. The Cache API cannot store 206 responses, so offline packages must store tiles or whole archives in IndexedDB.
2. **App core, basemap size.** Measured Protomaps Colorado extract sizes are 55 MB (z12), 122 MB (z13), 250 MB (z14) and 520 MB (z15). At 25 MB per file, a z14 basemap means about 11 regional archives and a way to route tiles to the right archive.
3. **App core, hosting backends.** GitHub release assets fail browser fetch (no CORS on the 302 or on the target). The docs say Git LFS cannot be used with Pages. The only workable backend is the Pages same-origin site, inside its 1 GB cap.
4. **Terrain and app core, Tier 1 source.** AWS Terrain Tiles over Berthoud are a 2017-11-12 render from pre-lidar NED (`x-amz-meta-x-imagery-sources: ned13/USGS_NED_13_n40w106_IMG.tif`). Against current 3DEP 1/3 arc-second, RMSE is 5.6 to 8.5 m; Mapterhorn is 1.4 to 1.9 m.
5. **Terrain lane, Tier 2 lineage.** Current `USGS_13_n40w106.tif` (published 2026-07-01) is 100% lidar over the pilot box. The split is DRCOG 2020 66%, ARP NF 2023 25%, Central/Western CO 2016 9%. The UTM pilot grid may touch n40w107, so read both tiles.
6. **Avalanche-model lane, canopy.** Use NLCD TCC v2025-6, year 2025:
   1. Values are percent canopy cover 0-100.
   2. 254 marks the non-processing area and 255 the background; treat both as NoData.
   3. CRS is Albers on the WGS 84 datum, not EPSG:5070.
   4. The file is a COG stored uncompressed inside a 3.6 GB zip, so it is window-readable via `/vsizip//vsicurl/`.

   It is not stem density and not binary.
7. **Routes lane.**
   1. OSM Colorado has 47 `piste:type=skitour` ways and 697 `piste:grooming=backcountry` features, 447 of them backcountry downhill descents.
   2. USFS `TrailNFS_Publish` has 345 SNOW-type segments in the Colorado bbox.
   3. COTREX `ski='yes'` (3958 features) marks an allowed use, not a route, and redistribution is not permitted.
   4. OpenSkiData allows one automated download per day. I did not download it, so the routes lane should be the only lane that does.
8. **Pipelines.** Mapterhorn returns 403 to the default Python `urllib` User-Agent. Set a descriptive User-Agent.

## 2. Decisions recommended

1. **Basemap.** Self-hosted Protomaps extract, build 20261105, maxzoom 14, regional archives. Optional imagery is USGS `USGSImageryOnly` (public domain, z16).
2. **Visual terrain.** Mapterhorn, with AWS Terrain Tiles as fallback. **Analytical terrain:** 3DEP 1/3 arc-second current COGs.
3. **Routes.** OSM (ODbL), OpenSkiData (own tiles), USFS SNOW trails, GNIS names. COTREX, huts.org, Friends of Berthoud Pass, CMC, SummitPost, Powder Project and Beacon are link-only.
4. **Land.** PAD-US 4.1 with the "manager, not access or parking" label.

## 3. Contract changes needed (lead decides)

1. Architecture section 3.3.1 names AWS Terrain Tiles as Tier 1. The evidence supports Mapterhorn as the default Tier 1 provider, with AWS as a configured fallback. Mapterhorn publishes no tile-endpoint usage policy, so offline terrain packages should use self-hosted Tier 2 products or AWS tiles until a policy permits prefetch.
2. Architecture section 1.3 sets 25 MB per file, which matches the GitHub web-upload limit. If deployment is by `git push`, 50 MiB avoids warnings and halves the archive count. The 1 GB published-site cap is the real constraint.

## 4. Blockers and untested

1. From about 00:28Z the sandbox lost DNS and TLS trust for curl, Go and the browsers. Later curl calls used pinned addresses. Browser decode tests, Mapterhorn pilot dry-runs below z16, and several downloads (PAD-US Colorado zip, BLM SMA, NLCD TCC window) are untested.
2. Real iPhone Safari was not tested; WebKit evidence comes from Playwright.
3. Permission is unresolved for COTREX (needs written CPW permission for redistribution) and Beacon (needs explicit license). The Mapterhorn offline prefetch policy is not stated.
4. Not verified: the Skimap.org license, and the SummitPost terms (403 to automated fetch).
