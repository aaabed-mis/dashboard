# Accounts Payable Dashboard

Executive AP dashboard for the corporate BI suite (design-consistent with the
Inventory dashboard). Tracks **outstanding payables** (unpaid open invoice lines)
and their aging from **SAP ECC PRD**.

## Data source & refresh

- **Fact:** `fact_accounts_payable` (`sap_prd.fact_accounts_payable`) in
  `Documents/duckdb/fact_accounts_payable.duckdb`, built by
  `Documents/duckdb/build_fact_accounts_payable_dlt.py`.
- **Model:** BSIK-only, vendor-level **FIFO payment-application**. One row per
  **unpaid** invoice line item (`Paid` lines are filtered at source).
  `remaining_amount = dmbtr - applied_amount` = the line's outstanding AP (positive SAR).
- **Refresh (manual):**
  1. Re-run the ETL if a new snapshot is wanted:
     `Documents/duckdb/build_fact_accounts_payable_dlt.py`
  2. Re-export the payload:
     `C:/Users/c.crizaldo/AppData/Local/Python/pythoncore-3.14-64/python.exe data/export_ap.py`
  3. Bump the `?v=` cache-buster on `data/data.js`, `app.js`, `styles.css` in `index.html`.
- Opens offline from `file://` (writes both `data/data.js` and `data/ap.json`).

## Pages

1. **Executive Overview** — KPI cards, aging distribution, overdue exposure,
   local/foreign, company code, top vendors, credit-days profile, payment terms,
   payment block, and a Management Attention concentration/exposure panel.
2. **Vendor Analysis** — vendor summary matrix (per-bucket aging, >90, blocked,
   concentration).
3. **Invoice Detail** — searchable/paginated open line items with export.

## Key definitions

- **Total Outstanding AP** = Σ `remaining_amount`.
- **Not Due** = `overdue_bucket = 'Not Due'` (due today or later).
- **Overdue AP** = `overdue_bucket <> 'Not Due'`.
- **Aging buckets:** Not Due / 0-30 / 31-60 / 61-90 / 91-120 / 120+ Days, computed
  vs `CAST(GETDATE() AS DATE)` at extract time (as-of = extract date).
- **Currency:** `dmbtr` / `remaining_amount` are **SAR** (company local currency),
  safe to aggregate across companies. `waers` = original invoice currency, informational only.

## Caveats (see documentation/KPI_Definitions.md for detail)

- `applied`/`remaining` are a **vendor-level FIFO allocation**, not SAP clearing
  (BSIK carries no clearing fields).
- `total_payment` is a vendor-level pool repeated per row — never summed across rows.
- `due_date = BUDAT + credit_days`; `credit_days` scraped from the T052U term text
  (`ADV`/missing text → 0).
- Figures are estimates for management monitoring, not audited accounting values.
