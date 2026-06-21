# Family Farm Planner — Spatial Layer Handover (current)

Bridge note for a new session (incl. Claude Code). Pairs with `STAGE5_MERGE_SPEC.md`. Memory + searching past conversations cover the rest; this pins exact decisions. Supersedes the earlier stage-1–4 handover.

## Where things stand
- Spatial work lives in a **standalone prototype**: `terrain_lidar.html` (one file, stages 2–4) + `darlington_test_dem_2m_MGA50.tif` (synthetic 2 m MGA50 test DEM with ridge, valley, deliberate null patch).
- **Not yet merged into `index.html`; not deployed.** The live app (`index.html` ~449 KB + `crops.json`, 237 entries) on GitHub Pages is unchanged.
- Next phase = the **stage-5 merge**, to be done in **Claude Code** against the repo (chosen to keep token/usage cost down on the large file — restructure into modules, edit surgically on disk, deploy via GitHub Desktop as now).

## Pipeline status
- **Stage 1 — boundary capture:** done. Leaflet + Geoman draw, Nominatim search, Turf geodesic area + override, soil entry, GeoJSON out. Basemaps: Esri (default), SLIP WA, OSM. **+ click-a-parcel** (see Stage 4).
- **Stage 2 — terrain sampling:** done. Grid over boundary+buffer; relief hillshade; resolution-floor / flat / null verdicts.
- **Stage 3 — analysis:** done. Pit-fill → slope, aspect (sun), flow accumulation, ponding, wetness. Five toggleable layers, stats clipped to boundary.
- **Stage 4 — design skeleton:** done. Rule-based facets (7 zones), formula-driven swales, two dam types.
- **Stage 5 — merge:** spec'd (`STAGE5_MERGE_SPEC.md`), NOT built.
- **Stage 6 — guild layout (intra-zone planting geometry):** designed (spec §F), NOT built.

## Elevation sources (settled)
- **Baseline = Esri Terrain3D ImageServer** (~30 m, CORS-confirmed live in browser; `getSamples`/`identify`).
- **Fallback = Open-Meteo Copernicus 90 m** (key-free).
- **OpenTopoData dropped** (CORS-blocked from browser).
- Source URL **parameterised** so a QLD/NSW (or future WA) high-res ImageServer drops in.
- **SLIP WA elevation = 10 m-grid contours (1998–2000), vector, not a sampleable raster.** No public WA 5 m DEM ImageServer exists → **LiDAR import is the only high-res path for Perth.**

## LiDAR acquisition (ELVIS)
- `elevation.fsdf.org.au`: draw a **small** AOI (well under the 1 km tile), order the **bare-earth DEM (DTM) GeoTIFF** — **NOT** the point cloud (LAZ) and not DSM. Result ≈ single-digit MB. (A 140 GB download = point cloud / whole region — wrong product.)
- Perth = **MGA Zone 50** (GDA94 EPSG:28350 or GDA2020 EPSG:7850). Tool auto-detects CRS via GeoKeys, with manual zone override.
- Tool reads **one tile at a time** (multi-tile mosaic not yet built).

## Stage 3 decisions
- **D8** flow direction; **priority-flood + epsilon** pit fill; flow accumulation by elevation-sorted accumulation (O(n log n)).
- **JavaScript, not WASM** — grids small (working grid capped ~6000 cells). WASM = WebAssembly (a speed runtime), only if a future stage stalls.
- Aspect = **downhill-facing direction**, southern-hemisphere semantics: N-facing = warm/sunny, S-facing = cool/frost-prone. (Validated vs synthetic planes + rasterio.)

## Stage 4 decisions
- **Rule-based facets, not clustering.** **7 zones:** Drainage line/wet valley · Frost hollow · Warm slope (N/E/W) · Cool slope (S) · Steep land · Flat productive · Exposed ridge/top. Each maps to a planting category.
- Thresholds (tunable): steep >18°; ponding >0.15 m = frost hollow; drainage = (channel OR top-15% wetness) AND slope <6°; flat <2°; ridge = top-30% elevation AND bottom-40% accumulation.
- **Swales — literature-based (SCS terrace-spacing):** `VI (m) = x·s + y`, s = slope %, **x from rainfall** (0.12 wet ↔ 0.24 dry; ~0.153 at Darlington 1100 mm — winter-dominant so mid-range), **y from soil** (0.3 erodible ↔ 1.2 resistant; ~0.6 loam, wider for sand/gravel). Computed at the median workable slope, then **capped to a harvesting band (~8–25 m)**. Confined to **2–12% slopes**; steeper = terrace/keyline zone, flatter = none. For Darlington loam: VI ≈ 1.5 m, ~25 m typical spacing. UI exposes rainfall, soil, runoff coeff, max-spacing cap.
- **Dams — two types:** **catchment dams** at valley outlets (lowest, max catchment/harvest) and **keyline dams** at primary-valley **keypoints** (the convex→concave slope break where the valley floor flattens — sited high for gravity feed; smaller catchment). Yield = catchment × rainfall × runoff coeff (defaults 1100 mm, 0.25); final sizing → the existing dam model. Shown in Water-plan layer (catchment = cyan, keyline = amber).
- **Click-a-parcel (WA cadastre): built.** Public point-queryable polygon layer "Cadastre (No Attributes) (LGATE-001)" on `services.slip.wa.gov.au/public` (CORS-confirmed). Click loads the parcel as the boundary, then editable. **Simplified geometry — planning-grade, not survey-exact.**
- Caveats: dam catchments nested (alternatives, not additive); swales/keypoints are siting guides at working-grid (~few-m) resolution; keypoint needs a real primary valley with a slope break (reports none otherwise).

## Stage 5 — the merge (see `STAGE5_MERGE_SPEC.md`)
- **Restructure first:** `index.html` → shell; `styles.css`; `planner.js` (allocation, ADG nutrition, water balance, dam sizing, `CLIMATE_DB`); `spatial.js` (ported from prototype); `crops.json` unchanged. The two JS modules talk **only** through the Site Model — no cross-reaching.
- **Site Model** (spatial → planner, one direction): boundary, area, centroid, `zones[]` (each with area_ha capacity, slope, sun, wetness, frostRisk, suitable/excluded categories, reserved `layout` slot), `water` (swaleable area, dams). **Optional** — absent ⇒ planner runs current single-area + soil mode (backward compatible).
- **Allocation:** single budget → per-zone sub-budgets with suitability gates; competition/diminishing-returns/opportunity-cost still global. Don't rewrite the allocator — change what the budget *is*.
- **Suitability derived from existing crop attributes** (`frost_hardy`, canopy layer, temperature optima, water requirement), not hand-tagged.

## Stage 6 — guild layout (spec §F, forward design)
Intra-zone planting geometry, runs after allocation. Southern-hemisphere rules: tallest in the **centre** (island guild) or on the **pole/south edge** (linear bed); sun-loving + **deciduous** on the **north/sun** side; **evergreen**/shelter on the **south/pole** side; slope reinforces the height stagger. Each zone's `layout` slot is reserved so this slots in with no rework. Heuristic (sound starting arrangement, not proven optimum).

## Data checks for the merge (`crops.json`)
- **water_requirement** field — needed for the wet/dry zone split (Stage 5). Confirm it exists; if not, add it.
- **phenology (deciduous/evergreen)** field — needed for Stage 6.
- Edit via the Python `OrderedDict`, one-object-per-line script; re-pull from raw GitHub first; never load the full file into a conversation.

## Technical gotchas (reinforced)
- **Never spread large typed arrays into `Math.min/max`** (stack overflow on the ~490k-cell grid) — use loop-based `minMax()`. Same for any O(n²) null-fill — use O(n) mean-fill.
- proj4 EPSG registry: MGA zones 49/50/51 (GDA94 + GDA2020) + geographic 4283/4326.
- Sample caps: network 800 pts, LiDAR 6000 pts, full-tile render 700 px longest side. In-memory bilinear LiDAR sampling verified to 0.12 m vs rasterio.
- `raw.githubusercontent.com` is the reliable source for current deployed file content; SILO/`longpaddock`/arcgis hosts are browser-only (not reachable from the container).

## Open items
1. Stage 5 merge (next) → then Stage 6.
2. Multi-tile LiDAR mosaic (tool loads one tile).
3. Overlay registration approximate (MGA→WGS84 corner reprojection; sub-pixel at property scale).
4. Native-resolution sampling cap could be lifted if a stage needs it.
