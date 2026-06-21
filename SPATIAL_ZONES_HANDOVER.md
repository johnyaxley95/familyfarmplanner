# Family Farm Planner — Spatial Layer Handover: Zones, Composition & Proximity

**Scope of this document.** This captures the design intent for how the spatial layer
categorises plants into zones, how those zones are internally composed, and how they are
placed relative to the house. It is written to be picked up cold in Claude Code during the
Stage 5 merge. It is a *design* handover, not a code handover — it records decisions and
their rationale so the implementation can be reconstructed faithfully.

---

## 0. Critical disambiguation — "zone" means three different things

Across the design sessions the word *zone* was overloaded. The single most important thing
for the next implementer to internalise is that there are **three distinct concepts**, and
conflating them will produce wrong behaviour. Keep them separate in code and naming.

| # | Concept | What it is | Lives on |
|---|---------|-----------|----------|
| **A** | **Crop classification tiers** (3) | A *property of each crop* — which management tier a species belongs to | The crop record (an attribute) |
| **B** | **Permaculture management zones** (1–5) | A *proximity/effort-distance surface* radiating from the dwelling | The land (a cost-distance raster) |
| **C** | **Terrain facets** (7) | A *biophysical segmentation* of the land into land-types | The land (a classified raster/polygon set) |

The placement logic is the **intersection** of all three: a crop's *tier* (A) decides how
close to the house it wants to be on the *management-zone surface* (B); the *terrain facets*
(C) decide which biophysical pocket of land at that distance actually suits it. Right crop
type, at the right effort-distance, on the right land.

---

## 1. Plant categorisation into zones — the 3 crop classification tiers (Concept A)

This is the taxonomy that answers "which zone does this plant belong to". It came out of the
guild-clustering / Excel workbook work and is a **crop attribute**, not a place.

- **Tier 1 — Horticultural.** Annual vegetables and intensive horticulture. High-attention,
  visited often, harvested continuously.
- **Tier 2 — Perennials (excluding nuts) + small livestock.** Fruit, berries, perennial veg,
  poultry/small stock. Lower attention than tier 1, still regular contact.
- **Tier 3 — Nuts, grain, and larger livestock.** Low-attention, infrequent contact, larger
  footprint, often allelopathic (nuts) or needing broad-acre space (grain, grazing).

**Why the tiers matter spatially.** The tier maps directly onto *how far from the house* a
crop should sit (Concept B): tier 1 wants Zone 1, tier 2 wants Zones 2–3, tier 3 wants
Zones 3–4. This is the original guiding intuition — *"annual vegetable areas close to the
house, orchards further away, nuts and livestock even further."* The tier is the bridge
between the crop database and the proximity surface.

---

## 2. How the zones are composed internally — guild structure (Concept A → guilds)

Once crops are grouped into compatible guilds, each guild is composed by a fixed set of
biophysical rules. These are the "what goes with what, and where within the cluster" rules.

**Grouping rules (which crops form a guild together):**

- **Hydrozone** — group plants of similar water demand together. Settled bands (data-tuned,
  not pairwise midpoints): **Low ≤700 mm, Moderate 700–1000 mm, High 1000–1400 mm,
  Very High 1400 mm+**, with each crop assigned by the **centre of its ROPMN–ROPMX range**.
- **Soil texture** — group by *tolerated-range overlap*, not exact match.
- **Drainage tolerance** — sourced from the AFCD **DRAR** column (not DRA).
- **Bioregion / shared origin** — plants of similar geographic origin cluster together.
- **Allelopathy segregation** — allelopathic species (**nut trees the major culprit**) are
  pulled out and grouped separately at generous spacings, never interleaved with sensitive
  crops.

**Internal arrangement (layout within a guild):**

- **Vertical gradation** — tallest plants at the **centre**, shortest at the **periphery**,
  giving a canopy → midstorey → understorey → groundcover gradient outward.
- **Aspect orientation** — **deciduous trees oriented north, evergreens south** (Southern
  Hemisphere: lets winter sun through deciduous canopy, uses evergreens to block on the
  cool side).
- **Nitrogen fixers** — dispersed throughout the guild rather than clustered.
- **Root stratification** — rooting depths (AFCD **DEP** optimal depth) **alternated between
  neighbours** to reduce root competition; same-depth adjacency is a conflict to avoid.

**Canopy-layer accounting (important implementation gotcha).** A guild's footprint is the
**MAX across canopy layers, not the sum** — each layer competes only against itself (canopy
vs canopy, understorey vs understorey). When a guild is too big for its best facet and must
spill into the next-best facet, **spillover operates per layer**, and the area check must use
the max-across-layers number. The naive "guild needs 800 m², bed has 500 m², spill 300 m²"
calculation uses the wrong area and will misplace plants.

---

## 3. Proximity from the house — permaculture management zones (Concept B)

This is the part that answers "how zones relate to the house". It is **not** radial rings.

**Mechanism: cost-distance surface.** Permaculture zones radiate from the dwelling as an
**accumulated cost-distance surface**, where per-cell movement cost is weighted by **slope**
and **blocked by impassable features** (creek, cliff). Zones therefore **hug easy-walking
contours and bend away from steep climbs**, rather than forming clean circles.

- **Zone 1** = the low-effort-distance basin nearest the dwelling (daily-visit intensity).
- Zones step **outward along contours**, intensity decreasing, out to wilderness.
- **Low-effort-distance is the PRIMARY definition of Zone 1** — it beats land quality. If the
  house sits on a ridge for the view, the near-house intensity surface wins over the fertile
  valley floor.

**Source of the spread — SETTLED.** The dwelling is a mandatory point source. Zone 1 always
seeds from the dwelling marker; the "no dwelling → seed from fertile valley" fallback was
scrapped (see §6 for rationale). The dwelling point is located automatically using the
following cascade, then confirmed by the user before the cost-distance surface is computed:

1. **Overpass API (OSM buildings)** — after the parcel polygon loads from the SLIP click-a-
   parcel mechanism, query Overpass for `building=*` features within the polygon. If one or
   more building footprints are found, take the centroid of the largest as the dwelling point
   and place a draggable marker there with the label *"We found a building here — drag if
   it's wrong."*
2. **Parcel centroid fallback** — if Overpass returns no buildings (rural lots with no OSM
   coverage), place the draggable marker at the parcel centroid with the label *"No building
   found — drag the marker to your dwelling."*

In both cases the marker is draggable and the user must confirm its position before the
cost-distance spread runs. The Esri World Imagery basemap is visible at this step, so users
can locate their house visually. **The dwelling point is always user-confirmed, never
silently assumed.**

Note: the SLIP public cadastre service ("Cadastre (No Attributes)") returns boundary geometry
only — no address, no title, no dwelling data — so SLIP cannot help with dwelling location.

**Why this is the right abstraction.** Classic permaculture zones are rings of *management
intensity*, and intensity is really a proxy for *effort-distance*, not straight-line
distance. Cost-distance makes "radial but contour-aware" precise, is a standard GIS
operation (least-cost spread from a source), and is defensible rather than hand-drawn.

---

## 4. The seven terrain facets — the land the placement runs on (Concept C)

This is the biophysical land segmentation that the Stage 4 design panel produces. It is
**built and proven on real georeferenced data** (this is the most concrete, validated part of
the spatial layer). Each facet carries the **planting category** that belongs there — this
mapping is the bridge into the planner's crop logic.

| Terrain facet | Planting category it carries |
|---------------|------------------------------|
| **Drainage line** | Water-lovers / high-water guilds |
| **Warm slope** | Orchard and vines |
| **Cool slope** | Berries and shade-tolerant |
| **Frost hollow** | Everything **except** frost-tender species (hard exclusion) |
| **Steep land** | Permanent cover (no cultivation) |
| **Flat** | Annual beds |
| **Ridge** | Windbreak |

**How facets are derived (hydrology pipeline):** fill sinks → flow direction (D8/D-inf) →
flow accumulation → threshold accumulation to extract channels; inverse (low accumulation)
gives ridges/divides. **Facets = elevation bands (contours) × hydrology class
(channel / mid-slope / ridge) × aspect.** Open tuning params: accumulation threshold for
channel extraction, number of contour bands, how tiny facets get merged into plantable
polygons.

The legend reports each facet's **share of total land area**, which feeds the planner's
constraint that each crop's suitability is gated by which facets exist and how much area each
holds.

---

## 5. How plants actually land on the facets — placement algorithm

- **Fit scoring is multiplicative** using **FAO EcoCrop thresholds** — Liebig's law of the
  minimum, **no hand-tuned weights**. Any failing gate eliminates (consistent with the rest
  of the app's architecture).
- **Placement is greedy-plus-swap-repair.** Scarcity priority emerges from **opportunity
  cost** rather than being assigned — no manual ordering.
- **Spillover is per canopy layer** (see §2), mirroring the existing perennial max-across-
  layers stacking rule.
- The crop's **classification tier (A)** sets its target **management zone (B)**; the
  **facets (C)** that fall within that zone band are the candidate land; EcoCrop fit picks
  among them.

---

## 6. Open / unresolved decisions — confirm before building

1. **Dwelling location — RESOLVED.** Mandatory point source, located automatically then
   user-confirmed. See §3 for the full Overpass → centroid → drag-to-confirm cascade. The
   valley-fallback idea is permanently scrapped: valleys are the most-contested land (Zone 1
   cropping, high-water guilds, and dams all compete for them), so auto-seeding Zone 1 there
   hard-wires one claimant before the contest. A region source also complicates the
   cost-distance spread unnecessarily. No code needed to support a region source.

2. **Zone-1 intensity vs land-quality tie-break — RESOLVED.** Low-effort-distance wins.
   With the mandatory dwelling approach the two surfaces always share the same anchor point,
   so no blend rule is needed.

3. **Seeds as a separate target / discretionary crop additions** — these are planner-side, not
   spatial, but noted because they affect which crops the placement has to site.

---

## 7. Failure modes to design against from the start

- **Flat sites (common Perth peri-urban).** Negligible slope → aspect, flow-accumulation,
  frost-hollow and cost-distance all degenerate (every cell looks identical, placement
  arbitrary). **Fallback:** when terrain variance < threshold, place on soil + zone-distance
  only, and **tell the user** terrain wasn't discriminating.
- **DEM resolution floor.** 30 m SRTM can't resolve a small creek or a suburban block (whole
  property may be 1–2 cells). Detect and switch to manual facet-painting or prompt for LiDAR
  import rather than producing confident-but-fake terrain analysis.
- **Null DEM cells (WA 5 m product).** Must not be read as zero elevation.
- **Off-property water inflow.** Water from upslope neighbours won't appear if you only sample
  inside the boundary. **Sample a buffer beyond the boundary** for terrain analysis even
  though placement stays inside.

---

## 8. Where this sits in the pipeline

The spatial pipeline exists as standalone files (`boundary_tool.html`,
`terrain_lidar.html`) and runs end-to-end: boundary capture → terrain sample/import →
analyse → Stage 4 design (facets, swales, dams). The remaining work is the **Stage 5 merge**:
wiring the facet zones into `index.html` so they constrain crop allocation, governed by
`STAGE5_MERGE_SPEC.md` (one-directional Site Model interface). The pre-merge refactor of the
monolith into modules (`index.html` shell, `styles.css`, `planner.js`, `spatial.js`,
`crops.json`) should happen before merging this logic in.

**Confirmed-good services:** Esri Terrain3D ImageServer (live elevation, CORS-open), ELVIS
(WA LiDAR DEM download — order-and-download, the only WA high-res path), SLIP WA cadastre,
Nominatim, SILO point API, Open-Meteo. **CORS-blocked:** OpenTopoData.
