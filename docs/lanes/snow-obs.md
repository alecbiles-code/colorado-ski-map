# Lane snow-obs: notes

Owner of `pipeline/snow|sar|incidents`, `data/snow|sar|incidents`, `schemas/station|incident.schema.json`, `.github/workflows/snodas.yml`. Full method and test log: `docs/methods/snow-sar-incidents.md`.

## 1. Findings

1. All Colorado SNOTEL and SNOLITE hourly data are stamped in fixed UTC-8 (AWDB `dataTimeZone: -8.0`), confirmed against the sun at four stations and unchanged across the 2026-11-01 DST switch. Daily values dated D are the hourly reading at D+1 00:00 UTC-8. An adapter that assumes Mountain time is off by one hour (two in summer).
2. AWDB `/stations` with all station elements returns HTTP 400; filter `elements`. `/data` and `/stations` send `access-control-allow-origin: *`; suspect values are dropped, so series have gaps by date.
3. SNODAS (NSIDC G02158 masked) is keyless over HTTPS, posted about 8 h after its 06:00 UTC valid time, big-endian int16, metres x 1000. NSIDC now runs it at a "Basic" level of service.
4. SNODAS SWE at SNOTEL sites matches SNOTEL closely (it assimilates them), which confirmed the decoding and geolocation; it is not independent validation.
5. raw.githubusercontent.com: ranged GET works (206, ACAO `*`) but the CORS preflight is refused (403). Hence fixed 16 KB numeric chunks instead of Range reads.
6. SAR hotspot archive tiles are uncompressed and reach 5.4 MB at z9; a phone needs a layer minzoom of 12. Published archives match the local d69692a files.
7. CAIC terms prohibit robots and data mining and reserve reproduction to prior written permission; avalanche.org's API asks users to seek permission. CAIC offers a Request for API Access form for apps.

## 2. Decisions

1. SNOLITE (4 stations) included; snow courses, SCAN and COOP left out.
2. SNODAS products in dated directories with a fixed-path meta; numeric grid in native cells (not resampled), PNG in Web Mercator for display only.
3. Data refresh via a single-commit `data` branch, as in the weather app; committed 2026-11-05 snapshot is the dated fallback.
4. Incidents ship empty with official links; importer requires a recorded authorization.

## 3. Blockers and open items

1. CAIC permission (see methods 5.3) unlocks the incident layer.
2. [ALEC TO CONFIRM: v2 ArcGIS thresholds behind the SAR `confidence` classes.]
3. Lead: add the data-branch base URL to `app/config.js`, or decide on Pages-from-Actions (methods 3.5).
4. NRCS AWDB terms text not found online (data.gov lists the U.S. Government works license but also "restricted public").
5. Not tested: a real-browser fetch of AWDB (headless Chrome 156 aborted at start in this environment, exit 134); the workflow on GitHub (never enabled or run); the app-side SNODAS and SAR rendering (owned by other lanes).
6. The local DNS resolver failed from about 00:29Z on 2026-11-06; later network checks used public-DNS addresses through `curl --resolve` and a scratch Python shim, never a system change.
