# Family Farm Planner — Stage 5 Merge Spec (Spatial × Planner)

Spec for the Claude Code session. Goal: wire the spatial pipeline (prototyped in `terrain_lidar.html`) into the deployed planner (`index.html` + `crops.json`) so facet zones and water features constrain crop allocation — **while keeping the existing simple workflow working unchanged**. Manage Claude usage by editing modules surgically on disk, not re-reading the monolith.

---

## A. File restructure — DO THIS FIRST (before any merge logic)

Break the ~449 KB monolith into modules so future edits only ever read the relevant file:

- `index.html` — page shell only: markup plus `<link>`/`<script src>` tags.
- `styles.css` — styling lifted out of the `<style>` block.
- `planner.js` — existing engine: greedy allocation + LP fallback, ADG 5-umbrella nutrition model, monthly water balance, dam sizing, `CLIMATE_DB`.
- `spatial.js` — boundary capture, terrain sampling (Terrain3D / Open-Meteo / LiDAR import), pit-fill + slope/aspect/flow/ponding/wetness analysis, facet classification, swales, dams (catchment + keyline). Ported from `terrain_lidar.html`.
- `crops.json` — unchanged.

**Hard rule:** `planner.js` and `spatial.js` never reach into each other's internals. They communicate **only** through the Site Model object (Section B). This is what keeps per-edit context small and preserves the one-directional pipeline (no circular deps).

**Verify the split works** (app loads, existing plan generation runs, regression harness passes) **before** adding any merge logic. Deployment is unchanged — GitHub Desktop pushes the file set; GitHub Pages serves multiple files fine. The app already loads CDN libraries, so it was never truly single-file.

---

## B. The interface — the Site Model (spatial → planner, one direction only)

The spatial engine runs first and emits one object the planner consumes. **No reverse dependency.** Dam *sizing* still happens in the planner after allocation, but it sizes against the candidate sites the spatial engine already handed over.

```
SiteModel = {
  boundary,                       // GeoJSON polygon
  area_ha, centroid,              // total area + {lat, lon} for climate/rainfall lookup
  zones: [
    {
      name,                       // e.g. "Warm slope (N/E/W)"
      area_ha,                    // capacity of this zone (limited sub-budget)
      slope_pct,
      sun: "warm" | "cool" | "neutral",
      wetness: "wet" | "mesic" | "dry",
      frostRisk: true | false,
      suitableCategories: [...],  // category-level gate (derived — Section D)
      excludedCategories: [...],
      layout: null                // reserved for Stage 6; null for now
    }
  ],
  water: {
    swaleableArea_ha,
    dams: [ { type: "catchment" | "keyline", lat, lon, catchment_ha, yield_kL } ]
  }
}
```

**Optional by design:** if no Site Model is present (user hasn't drawn a boundary / run analysis), the planner falls back to its **current single-area + soil mode**. The spatial layer is an enhancement that switches on when the data exists — it must not break the existing workflow.

---

## C. Allocation changes in `planner.js`

- Replace the single area budget with a set of **per-zone sub-budgets**, each with a finite `area_ha` capacity and a suitability gate.
- A crop may only be allocated into zones it suits (`suitableCategories`); it is excluded from zones in `excludedCategories`.
- **Competition stays global:** diminishing-returns marginal value, opportunity-cost scarcity priority, and canopy-layer stacking continue to operate across *all* zones at once — variety still emerges. This is the same allocator running against multiple constrained bins instead of one open bin (do **not** rewrite the allocator; change what the budget *is*).
- **Water:** harvestable `yield_kL` summed across candidate dams feeds the irrigation / water-balance logic; the existing dam-sizing step sizes a dam against the candidate sites after allocation.

---

## D. Deriving crop→zone suitability (data-driven, not hand-tagged)

Derive each crop's zone suitability from attributes `crops.json` already carries, rather than tagging 237 crops by hand (keeps it emergent, per project philosophy):

- `frost_hardy` → **frost-hollow** gate (non-hardy excluded).
- canopy layer (Canopy ≥25 m / Trees 4–24 m / Plants <4 m) → **tree-crop** zones (steep, cool slope) vs **annual-bed** zones (flat productive).
- temperature optima → **warm-slope vs cool-slope** split.
- water requirement → **wet (drainage) vs dry (ridge)** zones. **← DATA CHECK:** confirm `crops.json` carries a usable water-requirement signal; if not, this is the one field to add.

Map the 7 facet zones → category sets via these attributes. Build a regression check comparing plans with and without a Site Model.

---

## E. `crops.json` handling

- Edit with the Python `OrderedDict`, one-object-per-line script (load with `object_pairs_hook`, emit `"[\n" + ",\n".join(lines) + "\n]"`). **Never load the full file into a conversation.** Re-pull a fresh copy from the raw GitHub URL before editing.
- Possible new fields: `water_requirement` (Section D), and `phenology` (deciduous/evergreen) for Stage 6.

---

## F. Forward design — Stage 6: guild layout / planting geometry (NOT in this merge)

Runs **after** allocation, **within** each zone (you can't arrange a zone's plants until you know which are in it). Captured here so the interface is designed for it.

Inputs: zone polygon + aspect/slope (already produced) + the zone's assigned crops (height / canopy layer + phenology).

Rules (southern hemisphere — sun in the north, shadows fall south; arrange by height so a taller plant never sits between the sun and a shorter one):

- **Height stagger by sun.** Island/free-standing guild → tallest in the **centre**, tiers descending to edges. Linear bed/terrace → tallest on the **southern (pole) edge**, descending to the **northern (sun) edge**. Choose geometry by zone shape/width.
- **Phenology by aspect.** Sun-loving + **deciduous** → northern (sun) side (bare in winter, they admit low winter sun to plants behind). **Evergreen** / shade-tolerant / shelter → southern (pole) side (year-round shelter, no winter shade cast back onto the bed). Keep evergreens off the north side.
- **Use the slope.** On a sloped zone the downslope (northern) plants are physically lower, so taller upslope (southern) plants shade them less — the terrain reinforces the stagger.

**Architecture:** each `zone` already carries a `layout: null` slot. Stage 6 fills it (band/position output) with **no rework** to Stage 5. Honest note: this layer is heuristic — a sound starting arrangement, not a proven optimum.

---

## G. Build sequence for Claude Code

1. Restructure into modules; verify the app + regression harness still pass **before** merge logic.
2. Define the Site Model and the optional hook in `planner.js` (fallback when absent).
3. Port `spatial.js`; have it emit the Site Model.
4. Rework the allocator to per-zone budgets + gates; **keep the fallback**.
5. Wire dam yield → irrigation / dam-sizing.
6. Data check (Section D); add `crops.json` field(s) via the script if needed.
7. Run the `generatePlan` regression harness (the five configs) before and after each major change.

Stage 6 (guild layout) is a later, separate build.

---

## Carry-over open items (from the spatial sessions)
- Click-a-parcel (WA SLIP cadastre) is built and CORS-confirmed; simplified geometry, planning-grade.
- Swale spacing uses the SCS formula `VI = x·s + y` (x from rainfall, y from soil) capped to a harvesting band, on 2–12% slopes.
- Keyline dams sited at primary-valley keypoints (convex→concave slope break); catchment dams at valley outlets.
- Multi-tile LiDAR mosaic not yet built (tool loads one tile); overlay registration is approximate (sub-pixel at property scale).
