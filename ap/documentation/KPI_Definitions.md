# Accounts Payable Dashboard — KPI & Methodology Definitions

As-of: **2026-09-16** extract (aging vs `CAST(GETDATE() AS DATE)` at extract time).

## Source & grain

- Source: `fact_accounts_payable` (BSIK-only, SAP ECC PRD), built by
  `build_fact_accounts_payable_dlt.py`.
- Grain: one row per **unpaid** vendor line item — `(bukrs, lifnr, belnr, gjahr, buzei)`.
  `Paid` lines are excluded at source (`overdue_bucket <> 'Paid'`).
- Scope: **1,883** open lines · **287** vendors · company codes 1000 / 6000.

## KPI definitions (all on the filtered line-item set)

| KPI | Definition |
| --- | --- |
| **Total Outstanding AP** | `SUM(remaining_amount)` |
| **Not Due AP** | `SUM(remaining_amount)` where `overdue_bucket = 'Not Due'` |
| **Overdue AP** | `SUM(remaining_amount)` where `overdue_bucket <> 'Not Due'` |
| **AP >30 Days** | buckets `31-60`, `61-90`, `91-120`, `120+` |
| **AP >60 Days** | buckets `61-90`, `91-120`, `120+` |
| **AP >90 Days** | buckets `91-120`, `120+` |
| **AP >120 Days** | bucket `120+` |
| **Open Vendors** | distinct `lifnr` |
| **Open Invoices** | distinct `(bukrs, belnr, gjahr, buzei)` (0 duplicates at source) |
| **Payment Block Exposure** | `SUM(remaining_amount)` where `zlspr` is non-blank |

## Aging buckets

Computed in SQL at extract time (`CAST(GETDATE() AS DATE)` reference date):

| Bucket | Rule |
| --- | --- |
| Not Due | `due_date >= reference date` (due today or later) |
| 0-30 Days | `0 < DATEDIFF(day, due_date, ref) <= 30` |
| 31-60 Days | `31-60` days overdue |
| 61-90 Days | `61-90` days overdue |
| 91-120 Days | `91-120` days overdue |
| 120+ Days | `> 120` days overdue |

`due_date = BUDAT + credit_days`, where `credit_days` is parsed from the `T052U`
payment-term text (English). Terms containing `ADV`, or with no term text,
collapse to `0` credit days.

### Observed (2026-09-16)

| Bucket | Rows | Outstanding (SAR) |
| --- | ---: | ---: |
| Not Due | 376 | 51,604,197.63 |
| 0-30 Days | 334 | 15,085,972.62 |
| 31-60 Days | 120 | 8,603,687.10 |
| 61-90 Days | 70 | 5,177,419.30 |
| 91-120 Days | 50 | 1,080,473.75 |
| 120+ Days | 933 | 30,337,633.72 |
| **Total** | **1,883** | **111,889,384.12** |

Overdue (Not Due excluded) = **60,285,186.49** · AP >90 = **31,418,107.47**.

## Payment allocation (applied / remaining)

- **`applied_amount` / `remaining_amount`** come from a **vendor-level FIFO
  allocation**: the vendor's total `SHKZG='S'` payments (BSIK) are applied
  oldest-invoice-first across that vendor's open invoices (ordered by
  `BUDAT, BELNR, GJAHR, BUZEI`).
- This is an **allocation model, not SAP clearing** — BSIK carries no clearing
  fields (`AUGBL`/`AUGDT`). Do not reconcile `applied`/`remaining` to BSAK.
- **`total_payment`** is a vendor-level payment pool **repeated on every row** of
  that vendor — never `SUM()` it across rows (use `MAX(...) GROUP BY lifnr`).

## Currency & sign

- `dmbtr` / `remaining_amount` are **SAR** (company local currency) and are safe
  to aggregate across companies/codes. `waers` (8 invoice currencies present) is
  the **original document currency, informational only** — never summed per WAERS.
- Outstanding AP is shown as **positive** magnitudes (source `remaining_amount`
  is already positive; `Paid` lines are absent).

## Payment block

- Any **non-blank `zlspr`** is treated as a payment block. In scope (2026-09-16):
  **36 blocked lines · SAR 2,413,776.97** (full-view values; filter-aware in the dashboard).

## Dates

- `budat` / `bldat` are stored as **CHAR YYYYMMDD** in the fact table (rendered as
  dates by the dashboard). `due_date` is the only native DATE column.
- No key-date parameter: aging and the Not Due boundary move on every re-run.
  Always show **As of <extract date>**.

## Data-quality checks performed

- Duplicate `(bukrs, lifnr, belnr, gjahr, buzei)` keys: **0**.
- Null `due_date`: **0** (all lines have a due date).
- Negative `remaining_amount`: **0**.
- `remaining_amount > dmbtr`: **0**.
- Payment terms not defined: some lines carry `'Not Defined'` term text; a few
  lines have `TEXT1` NULL → `credit_days = 0` (due = posting date).

## Disclaimer

Figures are derived estimates for management monitoring and decision support
only, not audited accounting values. Payment allocation, due dates and aging
depend on the payment-term interpretation noted above. Validate against SAP
before financial decisions.
