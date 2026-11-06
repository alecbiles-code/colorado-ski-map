# Coverage report: routes, places, ski areas

Generated from the built products on 2026-11-06 by `pipeline/routes/coverage.py` (tables) plus the notes below. Regions are app-defined approximations (`data/coverage/regions.geojson`), not official or CAIC boundaries. Counts are features, not distinct named routes: OSM splits one trail into several ways.

## 1. Headline

1. Ski-specific geometry from open, redistributable sources is thin. Statewide there are 53 ski-specific features: 11 `ski_descent`, 40 `ascent_skin`, 2 `touring_area`. The lines total about 66 km. Most of them sit in two clusters, Maroon Bells (Elk) and the Collegiate Peaks (Sawatch).
2. Winter approaches are more common: 664 `approach` features. 332 are USFS TrailNFS segments with recorded snowshoe or cross-country ski use (about 1,850 km). 332 are OSM ways with a winter tag: ungroomed nordic, winter hike or snowshoe, tour routes on roads, and paths tagged `ski`, `ski:nordic` or `snowshoe`.
3. Lift-served terrain is kept apart. 3,964 downhill ways, 29 tour or uphill ways and 153 approach candidates fell inside lift-served context and are excluded from `routes.geojson`. 1,968 groomed nordic or winter-hike ways and 194 nordic ways with unknown grooming are excluded as pistes. Resort context is published separately as 135 ski areas (44 lift-served).
4. Points cover the state well: 3,867 peaks (398 GNIS-only), 380 passes and saddles (174 GNIS-only), 563 trailheads, 515 trailhead parking areas and 67 huts.
5. The search index has 5,708 named entries.

## 2. Data dates

| Source | Edition / date | Retrieved (UTC) |
|---|---|---|
| OpenStreetMap, Geofabrik Colorado extract | data up to 2026-11-03T21:24:23Z | 2026-11-06T00:14:30Z (md5 verified) |
| OpenSkiData ski areas (runs used as cross-check only) | build 2026-11-05T00:44Z from OSM 2026-11-04T01:00Z and Skimap.org 2026-11-04T23:27Z | 2026-11-06T00:05:25Z |
| USFS EDW TrailNFS_Publish (live service) | metadata pubdate 2025-05-14 | 2026-11-06T00:14:11Z |
| USGS GNIS Domestic Names, Colorado | published 2026-11-02 | 2026-11-06T00:06:45Z |
| Mapterhorn terrain tiles, Terrarium WebP 512 px, z13 (contract Tier 1 DEM) | live tiles; sample tile Last-Modified 2026-11-05T15:50:38Z; sources USGS 3DEP 1 m and 1/3 arc-second, Copernicus GLO-30 | 553 tiles, 2026-11-06T00:48 to 00:49Z |
| BLM Surface Management Agency (live service) | metadata pubDate 2026-09-22 | 2026-11-06T00:37:18Z |

## 3. Routes and places by region

Route columns: the three ski-specific classes come first. Then `approach` split by evidence: OSM tour route on a road or track, OSM ungroomed nordic, OSM winter-hike or snowshoe piste, OSM path with a `ski`/`ski:nordic`/`snowshoe` access tag, and USFS.

Route features by region (count)

| Region | ski_descent | ascent_skin | touring_area | approach_osm_tour_road | approach_osm_bc_nordic | approach_osm_winter_hike | approach_osm_access_tag | approach_usfs |
|---|---|---|---|---|---|---|---|---|
| front-range | 1 | 5 | 1 | 0 | 6 | 7 | 64 | 14 |
| summit-tenmile | 0 | 2 | 0 | 4 | 17 | 4 | 65 | 4 |
| vail-eagle-gore | 2 | 6 | 0 | 0 | 0 | 0 | 8 | 11 |
| sawatch | 3 | 1 | 0 | 0 | 0 | 0 | 1 | 41 |
| elk | 2 | 22 | 0 | 6 | 1 | 6 | 3 | 28 |
| san-juans | 3 | 3 | 0 | 2 | 11 | 0 | 19 | 60 |
| northern | 0 | 0 | 1 | 0 | 3 | 0 | 17 | 47 |
| sangre-de-cristo | 0 | 0 | 0 | 0 | 0 | 0 | 6 | 6 |
| grand-mesa | 0 | 0 | 0 | 0 | 23 | 1 | 0 | 52 |
| other | 0 | 1 | 0 | 0 | 9 | 42 | 7 | 69 |
| **total** | **11** | **40** | **2** | **12** | **70** | **60** | **190** | **332** |

Route length by region (km, rounded per feature)

| Region | ski_descent | ascent_skin | approach_osm_tour_road | approach_osm_bc_nordic | approach_osm_winter_hike | approach_osm_access_tag | approach_usfs |
|---|---|---|---|---|---|---|---|
| front-range | 0 | 4 | 0 | 2 | 4 | 103 | 64 |
| summit-tenmile | 0 | 2 | 9 | 34 | 5 | 20 | 12 |
| vail-eagle-gore | 2 | 15 | 0 | 0 | 0 | 39 | 29 |
| sawatch | 5 | 3 | 0 | 0 | 0 | 3 | 245 |
| elk | 4 | 18 | 11 | 6 | 16 | 4 | 168 |
| san-juans | 2 | 6 | 3 | 5 | 0 | 35 | 381 |
| northern | 0 | 0 | 0 | 7 | 0 | 43 | 146 |
| sangre-de-cristo | 0 | 0 | 0 | 0 | 0 | 5 | 63 |
| grand-mesa | 0 | 0 | 0 | 13 | 2 | 0 | 302 |
| other | 0 | 2 | 0 | 7 | 13 | 18 | 439 |
| **total** | **13** | **50** | **23** | **74** | **40** | **270** | **1849** |

Places by region

| Region | peak | peak_gnis_only | pass | pass_gnis_only | trailhead | parking | hut |
|---|---|---|---|---|---|---|---|
| front-range | 606 | 25 | 46 | 19 | 118 | 101 | 10 |
| summit-tenmile | 122 | 1 | 11 | 4 | 32 | 33 | 9 |
| vail-eagle-gore | 110 | 8 | 9 | 9 | 11 | 6 | 12 |
| sawatch | 138 | 6 | 15 | 8 | 21 | 35 | 5 |
| elk | 198 | 18 | 29 | 13 | 14 | 18 | 13 |
| san-juans | 626 | 43 | 34 | 34 | 103 | 64 | 7 |
| northern | 332 | 31 | 21 | 17 | 14 | 8 | 2 |
| sangre-de-cristo | 230 | 12 | 13 | 13 | 19 | 18 | 0 |
| grand-mesa | 56 | 18 | 0 | 0 | 2 | 5 | 1 |
| other | 1051 | 236 | 28 | 57 | 229 | 227 | 8 |
| **total** | **3469** | **398** | **206** | **174** | **563** | **515** | **67** |

Ski areas by region

| Region | lift_served | nordic_operating | abandoned | proposed | never_opened | disused |
|---|---|---|---|---|---|---|
| front-range | 7 | 2 | 19 | 0 | 0 | 0 |
| summit-tenmile | 4 | 2 | 3 | 0 | 0 | 0 |
| vail-eagle-gore | 3 | 1 | 1 | 0 | 0 | 0 |
| sawatch | 2 | 2 | 0 | 0 | 0 | 0 |
| elk | 7 | 2 | 4 | 0 | 2 | 0 |
| san-juans | 9 | 5 | 5 | 0 | 0 | 0 |
| northern | 4 | 1 | 12 | 5 | 0 | 0 |
| sangre-de-cristo | 1 | 0 | 4 | 0 | 0 | 0 |
| grand-mesa | 1 | 0 | 2 | 0 | 0 | 0 |
| other | 6 | 1 | 15 | 1 | 1 | 1 |
| **total** | **44** | **16** | **65** | **6** | **3** | **1** |


Excluded route candidates (OSM ways and USFS segments that had a ski or winter tag but are not in `routes.geojson`):

| Bucket | Count | Meaning |
|---|---|---|
| lift_served_context: ski_descent | 3964 | Downhill pistes within 500 m of an operating downhill ski-area polygon, 3 km of an operating or proposed ski-area point with no polygon, or 1 km of a lift |
| groomed_piste | 1968 | Groomed nordic, winter-hike and snowshoe trails (classic, skating, mogul) |
| nordic_grooming_unknown | 194 | Nordic ways with no grooming tag |
| non_ski_piste | 192 | Fatbike, sled, snow park, ski jump, ice skate, connection |
| lift_served_context: approach | 140 | Winter-tagged ways inside lift-served context |
| lift_served_context: ascent_skin | 29 | Resort uphill routes and `piste:type=yes` resort runs |
| lift_served_context: usfs_approach | 13 | USFS winter segments inside lift-served context |

## 4. What exists, region by region

1. **Front Range.** No OSM ski line at Berthoud Pass, Jones Pass, Loveland Pass, Butler Gulch, St. Mary's or Mount Evans. The ski-specific features are five `piste:type=yes` tour ways (one is "CMC Ski Trail"), the `Banana Bowl` area polygon, and a 167 m "Small snow sport trail". Approaches are richer. OSM has Brainard Lake winter routes and CMC snowshoe trails, Sourdough, Waldrop and South St. Vrain (`ski=designated`), RMNP Bierstadt and Moraine trails, and Fraser and Winter Park area trails. USFS adds Bakerville-Loveland, Diamond Lake, Kawuneeche, South Supply and Long Draw.
2. **Summit / Tenmile.** No descent lines. Two tour routes: Buffalo Cabin Trail and Mayflower Hill Approach. OSM approaches: Mayflower Gulch, Humbug Gulch and Mount Baldy road tour routes, Breckenridge-area ungroomed nordic roads (French Gulch, Boreas Pass Road), Peaks Trail, Quandary Peak Trail, and the county recpaths tagged `ski=designated`. Vail Pass has no OSM ski geometry. USFS supplies Shrine Pass Road, Burro XC, Tie Hack and Buckeye Gulch.
3. **Vail / Eagle / Gore.** Two descents: Cross Couloir (Mount of the Holy Cross) and Silver Couloir (Buffalo Mountain). Tour routes include Holy Cross Trail #2009 and Buffalo Mountain Trail. USFS hut access routes: Jackal Hut via Ranch Creek, 10th Mountain hut routes, West Tennessee Lakes. 10th Mountain huts are well covered as points.
4. **Sawatch.** Three named descents: Mt. Harvard South Face, Missouri Mountain Northface Couloirs and Mount Columbia Southwest Couloir. One tour route: Angel of Shavano (Snow Route). There are 41 USFS segments, for example Glacier Creek / Skinner Hut, Uncle Bud's Hut and Quartz Creek ski trails, plus shared snowmobile and ski routes at Cottonwood, Tincup and Cumberland passes. Independence and Cottonwood passes have no ski-specific lines.
5. **Elk Mountains.** The densest cluster. There are 22 tour-route ways around Maroon Lake, Maroon-Snowmass Trail, East Maroon, North Maroon Northeast Ridge and Pyramid Peak. Descents: The Landry Line and North Face of North Maroon Peak. Maroon Creek Road and Silver Pick Road are tour approaches. Crested Butte backcountry has no ski-specific lines. Its approaches come from USFS: Washington Gulch, Slate River, Schofield Pass, and Ohio Pass and Splains Gulch near Kebler.
6. **San Juans.** In the Wilson group (about 37.87 N, 107.99 W) there are three unnamed `freeride` downhill ways and three unnamed tour ways. Red Mountain, Coal Bank, Molas, Lizard Head and Wolf Creek passes have no ski-specific lines. The 60 USFS segments are nordic, snowshoe and shared snowmobile/ski routes, for example Pagosa-area ski loops, Owl Creek Pass, Spring Creek Pass and Turkey Springs.
7. **Northern.** No ski-specific lines at Cameron Pass, Rabbit Ears, Buffalo Pass, the Never Summers or the Flat Tops. The only ski-specific feature is one unnamed downhill area polygon north of Steamboat. Cameron Pass approaches are well covered, by both OSM and USFS: Joe Wright, Zimmerman Lake, Montgomery Pass, Meadow Snow, Sawmill, Diamond Peaks, Crags Basin and Blue Lake. Granby-area routes include Gravel Mountain, Pony Park and Kauffman Creek. Rabbit Ears has one OSM way (West Summit Loop).
8. **Sangre de Cristo.** No ski-specific geometry. USFS has six road approaches: South Colony, Hermit Lake, Cordova Pass, Greenhorn, Blue/Bear and Ophir Creek.
9. **Grand Mesa.** No ski-specific geometry. It has 52 USFS segments (Skyway, County Line and Ward Lake ski trails, and shared snowmobile routes) and 23 ungroomed nordic OSM ways.
10. **Other.** Mostly plains, parks and plateaus. It includes Snow Mountain Ranch winter-hike trails, Uncompahgre Plateau (Divide Road) nordic trails, and 69 USFS segments.

Many USFS winter routes are shared with snowmobiles (`usfsSnowMotorized: "Y"`, `usfsAllowedSnowUse` includes `snowmobile`). The app should show that.

## 5. Obvious gaps and why

1. The routes people most associate with Colorado touring (Berthoud, Loveland, Jones, Vail and Red Mountain passes, Cameron Pass, Rabbit Ears, Kebler, Coal Bank, Wolf Creek, Grand Mesa) have no descent or skin-track geometry in any redistributable source we found. Guidebook-grade lines exist in Beacon Guidebooks (via onX), huts.org GPX, Friends of Berthoud Pass, CMC, SummitPost and Powder Project. All are link-only (see `docs/sources/map-routes.md` section 6.6). COTREX has allowed-use flags but its terms forbid redistribution.
2. In OSM, backcountry descents and in-bounds expert terrain share the same tags (`piste:type=downhill` + `piste:grooming=backcountry`: 447 ways statewide, 438 of them inside lift-served context). Only spatial context separates them, so a real sidecountry line within 1 km of a lift is excluded, and a lift-less private run network more than 3 km from any ski-area record would be included. The lift-less clusters found so far (Cimarron Mountain Club, Ski Stout, Three Forks Ranch, Black Mountain, Irwin, Philip Miller Snow Park) are excluded by their Skimap.org points.
3. Direction is not mapped. The 40 `ascent_skin` features are undirected OSM tour routes, so treat them as "tour route" rather than a verified skin track. `classBasis` records the rule per feature.
4. The OpenSkiData cross-check agrees: it carries 38 Colorado runs with use `skitour`, against 51 OSM ways tagged `skitour` (OpenSkiData merges connected segments).
5. Peaks without a source elevation: 503 (398 GNIS-only plus 105 OSM peaks with no `ele`). The current GNIS release has no elevations. Their `elevationM` stays null. They carry `demElevationM` instead: a Mapterhorn z13 bilinear sample at the mapped point, 442 extra tiles, range 1,236 to 4,271 m. It is derived, not surveyed, and is never copied into `elevationM`. 89 OSM peaks and passes have a GNIS match within 300 m with a different name. They are flagged (`gnisNameMatch: false`) and not resolved. Most are spelling variants ("Peak 8" against "Peak Eight"), but a few are different features.
6. Ski areas: 31 OpenSkiData nordic clusters have no stable id and are omitted.
7. The OSM ways tagged `ski=yes` include paved recpaths (Summit County, Dillon). They are winter-ski-designated but are not backcountry.
8. Duplicates across sources are not merged. A USFS winter segment and an OSM path of the same trail can both appear.

## 6. Checks run

1. `pipeline/routes/test_routes.py` (pytest, 46 tests, all pass). Region anchor points (19 landmarks, each in its expected region). Classification rules. Relation-tag inheritance. Terrarium decode and tile math (Berthoud Pass tile matches the live endpoint). Horn aspect on synthetic planes in 5 orientations. Circular mean. Gain and loss. Elevation parsing. Schema validation of routes, places and ski areas against `schemas/*.schema.json`. Unique ids. 25 MB limit.
2. DEM decode and georeferencing (Mapterhorn z13). At 234 OSM peaks with `ele` whose tiles were cached for both DEMs, OSM ele minus the bilinear Mapterhorn sample had median +0.4 m (IQR -2.7 to +3.2 m). Against the earlier AWS Terrain Tiles run, the same difference had median +0.3 m (IQR -0.7 to +1.8 m), and Mapterhorn minus AWS had median 0.0 m (IQR -2.1 to +1.9 m). The tighter AWS agreement is expected and is not evidence that AWS is more accurate: many OSM peak elevations were copied from NED, the same lineage as the 2017 AWS render. The outliers are OSM `ele` errors (largest: Black Mesa, about -1,640 m). These checks verify the pipeline. For DEM accuracy, see the sources lane's measurement against current 3DEP near Berthoud Pass: Mapterhorn RMSE 1.4 to 1.9 m, AWS 5.6 to 8.5 m.
3. Descent aspects (Mapterhorn, degrees clockwise from true north) agree with the named faces: Missouri Northface Couloirs 7, Silver Couloir 15, Cross Couloir 48 (northeast to east), Mt. Harvard South Face 148, Mount Columbia Southwest Couloir 188. The DEM maxima are within 11 m of the summits: North Maroon 4,272.5 m, Harvard 4,391.6 m, Holy Cross 4,258.3 m.
4. Land status: SMA agency areas after repair and snapping are USFS 58,603 km2, BLM 33,788 km2, NPS 2,762 km2, consistent with published Colorado totals (about 14.5 and 8.3 million acres). All polygons are valid after `ST_MakeValid` + `ST_ReducePrecision`.
5. Link formats checked once (200): GNIS summary page (rendered client-side, content not verified), Skimap.org ski-area page, OSM way page.
