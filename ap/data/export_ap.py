"""Export Accounts Payable Dashboard payload from fact_accounts_payable.duckdb.

Run with the 3.14 Python (default 'python' is a 3.11 Hermes venv missing duckdb):
  C:/Users/c.crizaldo/AppData/Local/Python/pythoncore-3.14-64/python.exe export_ap.py

Writes BOTH data/data.js (inline window.__AP__ = {...}) and data/ap.json so the
dashboard works on file:// and http:// alike.

Fact (new schema, BSIK-only FIFO payment-application model, SAP ECC PRD):
  - One row per UNPAID invoice line item; 'Paid' lines are already filtered out
    at source (OVERDUE_BUCKET <> 'Paid').
  - remaining_amount = DMBTR - applied_amount = outstanding AP of the line, POSITIVE.
  - overdue_bucket = Not Due / 0-30 / 31-60 / 61-90 / 91-120 / 120+ Days, computed
    vs CAST(GETDATE() AS DATE) at extract time (no key-date parameter).
  - due_date = BUDAT + credit_days (credit_days scraped from T052U term text).
  - total_payment = VENDOR-LEVEL pool repeated per row -> never SUM() across rows.
  - budat/bldat are CHAR YYYYMMDD strings; due_date is the only DATE column.
  - dmbtr/remaining_amount are SAR (company local currency) - safe to aggregate
    across companies. waers = original invoice currency, informational only.

Shipped:
  - items : all unpaid line items (1.9k rows) - the single analytical source for
    KPIs, aging, vendor/company exposure, payment terms, payment block, detail.
  - meta  : generated_at, as_of, source, currency, grain, reconciliation totals.
All dimensions (companies, vendors, terms, buckets, blocks, years, currencies)
are derived client-side from `items` so every filter stays in sync.
"""
import duckdb, json, datetime, os

HOME = "C:/Users/c.crizaldo/OneDrive - Ahmad A. Abed Trading Co. Ltd/Documents"
DUCK = os.path.join(HOME, "duckdb")
OUT_DIR = os.path.dirname(os.path.abspath(__file__))
OUT_JSON = os.path.join(OUT_DIR, "ap.json")
OUT_JS = os.path.join(OUT_DIR, "data.js")
AP_DB = os.path.join(DUCK, "fact_accounts_payable.duckdb")
ADV_DB = os.path.join(DUCK, "fact_accounts_payable_advance.duckdb")

COLS = ("bukrs,lifnr,belnr,gjahr,buzei,budat,bldat,wrbtr,dmbtr,waers,zlspr,"
        "zterm,text1,credit_days,due_date,applied_amount,remaining_amount,"
        "overdue_bucket,name1,is_local")

def fetch(db, table):
    con = duckdb.connect(db, read_only=True)
    try:
        return con.execute(f"SELECT {COLS} FROM sap_prd.{table}").fetchall()
    finally:
        con.close()

# Combined source: vendor invoices (fact_accounts_payable) UNION advance
# payments (fact_accounts_payable_advance). Identical 20-col schema; the
# advance rows carry overdue_bucket = 'Advance Payment'.
rows = fetch(AP_DB, "fact_accounts_payable") + fetch(ADV_DB, "fact_accounts_payable_advance")

def d(v):
    return v.isoformat() if v else ""

def ymd(s):
    """CHAR YYYYMMDD -> YYYY-MM-DD (budat/bldat are strings in this schema)."""
    if not s or len(str(s)) != 8:
        return ""
    s = str(s)
    return f"{s[:4]}-{s[4:6]}-{s[6:8]}"

items = []
for r in rows:
    items.append([
        r[0], r[1], r[2], r[3], r[4],
        ymd(r[5]), ymd(r[6]),
        round(float(r[7]), 2), round(float(r[8]), 2), r[9],
        r[10], r[11], r[12] or "",
        int(r[13]) if r[13] is not None else 0,
        d(r[14]),
        round(float(r[15]), 2), round(float(r[16]), 2),
        r[17], r[18] or "", r[19],
    ])

n = len(items)
total_rem = sum(i[16] for i in items)
total_appl = sum(i[15] for i in items)
total_dmb = sum(i[8] for i in items)
vendors = len({i[1] for i in items})

as_of = datetime.date.today().isoformat()

meta = {
    "generated_at": datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
    "source": "fact_accounts_payable + fact_accounts_payable_advance (duckdb), BSIK-only FIFO payment-application, SAP ECC PRD",
    "as_of": as_of,
    "currency": "SAR",
    "grain": "one row per UNPAID vendor line item (bukrs + lifnr + belnr + gjahr + buzei); invoices + advance payments",
    "rows": n,
    "vendors": vendors,
    "total_remaining": round(total_rem, 2),
    "total_applied": round(total_appl, 2),
    "total_dmbtr": round(total_dmb, 2),
    "notes": [
        "Combined source: fact_accounts_payable (vendor invoices, SHKZG='H') UNION fact_accounts_payable_advance (advance payments, SHKZG='S').",
        "remaining_amount = outstanding AP of each line (POSITIVE SAR); Paid lines filtered at source.",
        "overdue_bucket = Not Due / 0-30 / 31-60 / 61-90 / 91-120 / 120+ Days (invoices) or Advance Payment (advances), vs CAST(GETDATE() AS DATE).",
        "due_date = BUDAT + credit_days (credit_days scraped from T052U term text; ADV/missing text -> 0).",
        "total_payment is a vendor-level payment pool repeated per row - never SUM() across rows.",
        "applied/remaining come from a vendor-level FIFO allocation, NOT SAP clearing (BSIK, no AUGBL/AUGDT).",
        "dmbtr/remaining_amount are SAR; waers = original invoice currency, informational only.",
        "budat/bldat are CHAR YYYYMMDD strings; due_date is the only DATE column.",
    ],
}

payload = {"meta": meta, "items": items}

for path, as_js in [(OUT_JSON, False), (OUT_JS, True)]:
    with open(path, "w", encoding="utf-8") as f:
        if as_js:
            f.write("window.__AP__ = ")
        json.dump(payload, f, ensure_ascii=False, separators=(",", ":"))
        if as_js:
            f.write(";")

print("items:", n, "| vendors:", vendors)
print("total remaining:", round(total_rem, 2), "| applied:", round(total_appl, 2), "| dmbtr:", round(total_dmb, 2))
print("File size bytes:", os.path.getsize(OUT_JSON))
print("DONE")
