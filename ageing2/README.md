# Material Aging Dashboard — ageing2

This folder is an independent copy of `../aging`, created as a second version
for future amendments. It is not added to the hub navigation. When deployed
under the dashboard site, its path is `/ageing2/`.

The copied access gate uses the existing `material-aging` dashboard permission;
no new Supabase role or configuration is required. Data and assets are copied,
not shared with `../aging`, so later changes to either folder do not update the
other automatically.

Note: the login gate controls the dashboard interface, not direct access to
static files on public hosting. Treat the included JSON/JavaScript data as
public if the repository or hosting is public.

Offline, self-contained HTML dashboard for SAP material stock aging & expiry exposure.

## What it is
A single-page dashboard (no server, no internet) that opens by double-clicking `index.html`.
It visualizes batch stock value at risk across aging buckets, with filters, KPI cards,
charts, a Top 10 materials table, a Batch Detail table, and a Dead Stock table.

## Files
- `index.html` — entry point
- `styles.css` — dark theme
- `app.js` — data aggregation, charts, tables, filters
- `assets/chart.umd.min.js` — local Chart.js (v4)
- `assets/logo.png`, `assets/favicon.ico` — branding
- `data/data.js` — inline dashboard data (generated; required for `file://` open)
- `data/material_aging.json` — same data as JSON (for `http://` serving)
- `data/export_aging.py` — regenerates the data from `material_aging.duckdb`

## Data sources (SAP ECC PRD)
- `material_aging.duckdb` (`sap_prd.material_aging`) — batch stock from MCHB joined to
  MBEW (valuation), MCHA (shelf life), MARM, MAKT, MARA/TWEWT, T001W.
  Stock value = `clabs × ma_price` (VERPR).
- `avg_sales_6mo.duckdb` — per-material 6-month avg sales (from `fact_ztsd_detail`).
- `fact_ztsd_detail` — SAP billing; provides **last sales date** (`MAX(inv_date)` per material).
- `>120 Days` bucket is excluded from all dashboard views (load-time filter).

## Refresh
```
python data/export_aging.py
```
Then reopen `index.html`.

## Run
Double-click `index.html` (uses inline `data/data.js`).
