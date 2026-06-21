# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Running the App

This is a zero-dependency, no-build client-side web app. Open `index.html` directly in a browser — but note that `crops.json` must be served over HTTP (not `file://`) due to browser fetch restrictions. Use any local server:

```powershell
python -m http.server 8080
# then open http://localhost:8080
```

There are no tests, no linter, no package manager, and no build step.

## Architecture

The entire application is **`index.html`** — one monolithic file with CSS, HTML structure, and all JavaScript inlined. There is no framework or module system.

**`crops.json`** is the only external data file. It is loaded asynchronously on startup via `fetch("crops.json")` and stored in the global `CROP_DATA` array.

**`terrain_lidar (4).html`** is a standalone, independent tool for terrain/LiDAR import using the Leaflet mapping library. It has no connection to `index.html`.

## Key Concepts

**Global state** — a single `state` object (defined around line 2066) holds all user inputs and computed results. All rendering reads from this object. There is no reactive framework; `renderApp()` rebuilds the entire UI on each state change.

**7-step wizard flow** — navigation is controlled by `goStep(n)`:
- 0: Household (add family members, select diet type from `ADG`)
- 1: Farm Details (location, climate zone, soil type, water supply, land area)
- 2: Crop Selection (filterable table from `CROP_DATA`)
- 3: Farm Plan (LP-based auto-allocation via `generatePlanLP()`)
- 4: Manual Adjustment (tweak crop areas and livestock)
- 5: Summary (nutrition coverage, water/labour budgets, charts)
- 6: Species Database (read-only browse of all crops)

**Crop data schema** — each entry in `crops.json` includes: `name`, `food_group`, `serve_g`, `yield_low`/`yield_high` (t/ha), growing `months` (P=primary, S=secondary), `perennial` flag, `labour_hand`/`labour_mech` (hrs/ha), climate zone list (`cliz`), temperature/rainfall/pH tolerances, `nut` nutrition map (per 100g), and `kc` irrigation coefficients.

**Plan generation** — `generatePlanLP()` (line 3776) runs a linear program to allocate land area across selected crops, targeting the household's Australian Dietary Guideline (`ADG`) serves per day across food groups. `buildPlanFromLP()` (line 3857) converts LP output into the plan stored in `state`.

**Nutrition model** — `ADG` constants define daily serve targets per person type. `calcTotals()` sums household targets; `nutritionalYield()` maps crop yields to nutrients using `NRV` (Nutrient Reference Values). Food groups are mapped via `FG_KEY`, `UMBRELLA_GROUPS`, and `FG_DISPLAY` constants.

**Climate/location** — `ZONES` defines Australian climate zones (Köppen), `TOWNS` lists ~90 Australian towns with lat/lon and zone, and `CLIMATE_DB` holds monthly rainfall and ETo (evapotranspiration) data. `selectTown()` updates state when the user picks a location.

**Yield calculation** — `subsistYield(crop, fertility, confidence)` adjusts the crop's midpoint yield by a fertility multiplier (`FERTILITY_MULT`) and confidence factor. `cropAnnualIrrigationPerHa()` uses crop Kc coefficients against monthly ETo and rainfall to estimate irrigation demand.
