"""Export Sales Dashboard payload from SAP PRD DuckDB dimensions/facts.

Run with the 3.14 Python (default 'python' is a 3.11 Hermes venv missing duckdb):
  C:/Users/c.crizaldo/AppData/Local/Python/pythoncore-3.14-64/python.exe export_sales.py

Writes BOTH data/data.js (inline window.__SALES__ = {...}) and data/sales.json so
the dashboard works on file:// and http:// alike.

Sources (SAP ECC PRD, dlt datasets in Documents/duckdb, schema 'sap_prd'):
  - fact_ztsd_detail     : line-level billing fact (6.7M rows, zmonth 202401..202609).
                            sales_office IS the plant key (no WERKS column).
                            net_value is net of returns (returns/credits are negative).
                            qty_in_sku = base/SKU units (do not mix with order units).
  - fact_plant_sales_target : monthly plant sales target, grain werks + zmonth.
  - dim_plants            : plant/company/region master, join on sales_office = werks.
                            name2 = Branch/Showroom/Warehouse/Online/Horeca. Segment is
                            DERIVED from name2 here (Branch|Warehouse=B2B, Showroom=B2C,
                            Horeca=HRC, Online=OLN); segment is a plant attribute, not per-invoice.
  - dim_ztso_details      : invoice-type classification. fkart = inv_type.
                            zindicator SI=Sales(+1) / RI=Return(-1) / ST=Special(+1).
                            Used ONLY for the reliable sales-vs-return sign (zsign).

Payload:
  - rows     : pre-aggregated ym x sales_office x segment (2.6k rows). Each carries
               sales (SUM net_value of SI/ST lines), returns (SUM of RI/negative lines,
               POSITIVE magnitude), qty_in_sku, cogs (SUM cost_price of SI/ST lines),
               invoice count. This is the single filterable engine for trend / plant /
               segment / executive views.
  - targets  : werks x zmonth target totals.
  - plants   : werks -> name, company (bukrs), region, city, segment (from name2).
  - salesmen : emp_no x zmonth aggregate (sales / returns / qty), for the salesman page.
  - customers: top-N customers x zmonth (sales / returns / qty) for the customer page.
  - ext_grp  : ym x plant x external material group (mat_ext_grp). Each carries sales,
               returns, cogs (GP = sales - cogs). No target at this grain.
  - meta     : generated_at, as_of, source, currency SAR, grain, reconcile totals.

IMPORTANT: 6.7M lines never ship to the browser. Every dataset below is pre-aggregated
to a small analytical grain; the frontend filters over `rows` (ym/plant/segment), so
all filters stay in sync and every KPI reconciles to the sum of the filtered rows.
"""
import duckdb, json, datetime, os

HOME = "C:/Users/c.crizaldo/OneDrive - Ahmad A. Abed Trading Co. Ltd/Documents"
DUCK = os.path.join(HOME, "duckdb")
OUT_DIR = os.path.dirname(os.path.abspath(__file__))
OUT_JSON = os.path.join(OUT_DIR, "sales.json")
OUT_JS = os.path.join(OUT_DIR, "data.js")

con = duckdb.connect()
con.execute("ATTACH '{}' AS f (READ_ONLY)".format(os.path.join(DUCK, "fact_ztsd_detail.duckdb").replace("'", "''")))
con.execute("ATTACH '{}' AS p (READ_ONLY)".format(os.path.join(DUCK, "dim_plants.duckdb").replace("'", "''")))
con.execute("ATTACH '{}' AS t (READ_ONLY)".format(os.path.join(DUCK, "fact_plant_sales_target.duckdb").replace("'", "''")))
con.execute("ATTACH '{}' AS z (READ_ONLY)".format(os.path.join(DUCK, "dim_ztso_details.duckdb").replace("'", "''")))
con.execute("ATTACH '{}' AS fc (READ_ONLY)".format(os.path.join(DUCK, "fact_foc.duckdb").replace("'", "''")))
con.execute("ATTACH '{}' AS gd (READ_ONLY)".format(os.path.join(DUCK, "fact_gdrn.duckdb").replace("'", "''")))
con.execute("ATTACH '{}' AS fcst (READ_ONLY)".format(os.path.join(DUCK, "fact_forecast.duckdb").replace("'", "''")))
con.execute("ATTACH '{}' AS mm (READ_ONLY)".format(os.path.join(DUCK, "dim_material_master.duckdb").replace("'", "''")))

# Classified fact view: sales/return sign from dim_ztso_details; segment from plant name2.
con.execute("""
CREATE OR REPLACE VIEW cls AS
SELECT f.sales_office AS w,
       f.zmonth AS ym,
       COALESCE(CASE TRIM(p.name2)
           WHEN 'Branch' THEN 'B2B'
           WHEN 'Warehouse' THEN 'B2B'
           WHEN 'Showroom' THEN 'B2C'
           WHEN 'Horeca' THEN 'HRC'
           WHEN 'Online' THEN 'OLN'
           ELSE '' END, '') AS seg,
       COALESCE(CAST(z.zsign AS INT), 1) AS zsign,
       f.inv_no, f.emp_no, f.emp_name, f.customer, f.cus_name,
       f.net_value, f.qty_in_sku, f.cost_price,
       COALESCE(f.mat_ext_grp, '') AS eg,
       COALESCE(f.mat_ext_grp_des, '') AS eg_des
FROM f.sap_prd.fact_ztsd_detail f
LEFT JOIN z.sap_prd.dim_ztso_details z ON f.inv_type = z.fkart
LEFT JOIN p.sap_prd.dim_plants p ON f.sales_office = p.werks
WHERE f.sale_org <> '6000'
  AND f.inv_type NOT IN ('ZAST', 'ZR1I', 'ZRTL', 'ZRTR')
""")

# ---- rows: ym x plant x segment ----
rows = []
for w, ym, seg, sales, returns, qty, n_inv, cogs in con.execute("""
    SELECT w, ym, seg,
           SUM(CASE WHEN zsign >= 0 THEN net_value ELSE 0 END) AS sales,
           -SUM(CASE WHEN zsign < 0 THEN net_value ELSE 0 END) AS returns,
           SUM(qty_in_sku) AS qty,
           COUNT(DISTINCT inv_no) AS n_inv,
           SUM(CASE WHEN zsign >= 0 THEN cost_price ELSE 0 END) AS cogs
    FROM cls GROUP BY 1,2,3 ORDER BY ym, w, seg""").fetchall():
    rows.append([ym, w, seg, round(float(sales or 0),2), round(float(returns or 0),2),
                 round(float(qty or 0),0), int(n_inv or 0), round(float(cogs or 0),2)])

# ---- targets: plant x month ----
targets = [[r[0], r[1], round(float(r[2]), 2)] for r in con.execute(
    "SELECT werks, zmonth, SUM(ztarget) FROM t.sap_prd.fact_plant_sales_target GROUP BY 1,2").fetchall()]

# ---- plants: werks -> name, company, region, city, segment (from dim_plants.name2) ----
plants = [[r[0], r[1] or "", r[2] or "", r[3] or "", r[4] or "", r[5] or ""] for r in con.execute(
    "SELECT werks, name1, bukrs, regio, ort01, "
    "COALESCE(CASE TRIM(name2) WHEN 'Branch' THEN 'B2B' WHEN 'Warehouse' THEN 'B2B' "
    "WHEN 'Showroom' THEN 'B2C' WHEN 'Horeca' THEN 'HRC' WHEN 'Online' THEN 'OLN' ELSE '' END,'') "
    "FROM p.sap_prd.dim_plants").fetchall()]

# ---- salesmen: emp x month ----
salesmen = [[r[0], r[1], r[2], round(float(r[3] or 0),2), round(float(r[4] or 0),2), round(float(r[5] or 0),0)]
            for r in con.execute("""
    SELECT emp_no, emp_name, ym,
           SUM(CASE WHEN zsign >= 0 THEN net_value ELSE 0 END),
           -SUM(CASE WHEN zsign < 0 THEN net_value ELSE 0 END),
           SUM(qty_in_sku)
    FROM cls GROUP BY 1,2,3 ORDER BY 3,1""").fetchall()]

# ---- external material group: ym x plant x ext_grp (for the executable table, period-filterable) ----
ext_grp = []
for ym, w, eg, eg_des, sales, returns, cogs in con.execute("""
    SELECT ym, w, eg, eg_des,
           SUM(CASE WHEN zsign >= 0 THEN net_value ELSE 0 END) AS sales,
           -SUM(CASE WHEN zsign < 0 THEN net_value ELSE 0 END) AS returns,
           SUM(CASE WHEN zsign >= 0 THEN cost_price ELSE 0 END) AS cogs
    FROM cls GROUP BY 1,2,3,4 ORDER BY ym, sales DESC""").fetchall():
    ext_grp.append([ym, w, eg, eg_des or "", round(float(sales or 0),2),
                    round(float(returns or 0),2), round(float(cogs or 0),2)])

# ---- Free-of-goods cost (fact_foc) : ym x plant, SUM(amount). erdat is the billing date. ----
foc = []
for ym, w, amt in con.execute("""
    SELECT strftime(f.erdat,'%Y%m') AS ym, f.werks AS w, SUM(f.amount) AS amt
    FROM fc.sap_prd.fact_foc f
    WHERE f.werks NOT IN ('6001','6002')
    GROUP BY 1,2 ORDER BY ym, w""").fetchall():
    foc.append([ym, w, round(float(amt or 0),2)])

# ---- Disposal value (fact_gdrn) : ym x plant, SUM(dmbtr). budat_mkpf is the posting date. ----
gdrn = []
for ym, w, val in con.execute("""
    SELECT strftime(g.budat_mkpf,'%Y%m') AS ym, g.werks AS w, SUM(g.dmbtr) AS val
    FROM gd.sap_prd.fact_gdrn g
    WHERE g.werks NOT IN ('6001','6002')
    GROUP BY 1,2 ORDER BY ym, w""").fetchall():
    gdrn.append([ym, w, round(float(val or 0),2)])

# ---- products: top 1500 BY MATERIAL, grain MATERIAL x MONTH (period-filterable) ----
# Grain is material only (NOT material x description): the same material carries several
# material_des spellings in ZTSD_DETAIL (case/punctuation variance), which used to split one
# product into 2-4 rows and dilute the top-1500 cut. The canonical description is the one
# with the highest sales (arg_max) and ships ONCE per material in `prod_info`, so the
# month-grain rows stay numeric and small.
#   top_mats   : the 1500 materials by total sales (material only) -> temp table
#   prod_info  : [material, mat_des, mat_ext_grp, mat_ext_grp_des]      (display lookup)
#                mat_des comes from dim_material_master.maktx (MAKT English text) - the ONE
#                canonical spelling. ZTSD_DETAIL carries up to 14 material_des spellings per
#                material (case drift + Arabic), so the fact text is only the FALLBACK for the
#                ~5 materials missing from the plant-2401-scoped master.
#   products   : [material, ym, sales, returns, qty, inv, cogs]         (material x month)
#   prod_foc   : [material, ym, amount]  SUM(fact_foc.amount),  ym from erdat
#   prod_disp  : [material, ym, value]   SUM(fact_gdrn.dmbtr),  ym from budat_mkpf
#   prod_fcst  : [material, ym, plan]    SUM(fact_forecast.zbvalue)  (module month only, 202609)
# FOC / Disposal / forecast are filtered to the SAME material scope and to the same
# 202401..202609 window as `rows`, so the By Product page reconciles with the other pages.
con.execute("""
CREATE OR REPLACE TEMP TABLE top_mats AS
WITH base AS (
  SELECT f.material,
    SUM(CASE WHEN COALESCE(CAST(z.zsign AS INT),1)>=0 THEN f.net_value ELSE 0 END) sales
  FROM f.sap_prd.fact_ztsd_detail f
  LEFT JOIN z.sap_prd.dim_ztso_details z ON f.inv_type = z.fkart
  WHERE f.sale_org <> '6000' AND f.inv_type NOT IN ('ZAST','ZR1I','ZRTL','ZRTR')
  GROUP BY 1
)
SELECT material FROM base ORDER BY sales DESC LIMIT 1500
""")

prod_info = [[r[0], r[1] or "", r[2] or "", r[3] or ""] for r in con.execute("""
    WITH denorm AS (
      SELECT f.material,
        arg_max(f.material_des,    CASE WHEN COALESCE(CAST(z.zsign AS INT),1)>=0 THEN f.net_value ELSE 0 END) fact_des,
        arg_max(f.mat_ext_grp,     CASE WHEN COALESCE(CAST(z.zsign AS INT),1)>=0 THEN f.net_value ELSE 0 END) eg,
        arg_max(f.mat_ext_grp_des, CASE WHEN COALESCE(CAST(z.zsign AS INT),1)>=0 THEN f.net_value ELSE 0 END) eg_des
      FROM f.sap_prd.fact_ztsd_detail f
      JOIN top_mats t ON t.material = f.material
      LEFT JOIN z.sap_prd.dim_ztso_details z ON f.inv_type = z.fkart
      WHERE f.sale_org <> '6000' AND f.inv_type NOT IN ('ZAST','ZR1I','ZRTL','ZRTR')
      GROUP BY 1
    )
    SELECT d.material,
      COALESCE(NULLIF(TRIM(m.maktx), ''), d.fact_des),
      d.eg, d.eg_des
    FROM denorm d
    LEFT JOIN mm.sap_prd.dim_material_master m ON m.matnr = d.material""").fetchall()]

products = []
for r in con.execute("""
    SELECT f.material, f.zmonth,
      SUM(CASE WHEN COALESCE(CAST(z.zsign AS INT),1)>=0 THEN f.net_value ELSE 0 END) sales,
      -SUM(CASE WHEN COALESCE(CAST(z.zsign AS INT),1)<0 THEN f.net_value ELSE 0 END) ret,
      SUM(f.qty_in_sku) qty,
      COUNT(DISTINCT f.inv_no) inv,
      SUM(CASE WHEN COALESCE(CAST(z.zsign AS INT),1)>=0 THEN f.cost_price ELSE 0 END) cogs
    FROM f.sap_prd.fact_ztsd_detail f
    JOIN top_mats t ON t.material = f.material
    LEFT JOIN z.sap_prd.dim_ztso_details z ON f.inv_type = z.fkart
    WHERE f.sale_org <> '6000' AND f.inv_type NOT IN ('ZAST','ZR1I','ZRTL','ZRTR')
      AND f.zmonth BETWEEN '202401' AND '202609'
    GROUP BY 1,2 ORDER BY 2, 3 DESC""").fetchall():
    products.append([r[0], r[1], round(float(r[2] or 0),2), round(float(r[3] or 0),2),
                     round(float(r[4] or 0),0), int(r[5] or 0), round(float(r[6] or 0),2)])

prod_foc = []
for r in con.execute("""
    SELECT fc.matnr, strftime(fc.erdat,'%Y%m') AS ym, SUM(fc.amount)
    FROM fc.sap_prd.fact_foc fc
    JOIN top_mats t ON t.material = fc.matnr
    WHERE fc.werks NOT IN ('6001','6002')
    GROUP BY 1,2 HAVING ym BETWEEN '202401' AND '202609' ORDER BY 2,1""").fetchall():
    prod_foc.append([r[0], r[1], round(float(r[2] or 0),2)])

prod_disp = []
for r in con.execute("""
    SELECT gd.matnr, strftime(gd.budat_mkpf,'%Y%m') AS ym, SUM(gd.dmbtr)
    FROM gd.sap_prd.fact_gdrn gd
    JOIN top_mats t ON t.material = gd.matnr
    WHERE gd.werks NOT IN ('6001','6002')
    GROUP BY 1,2 HAVING ym BETWEEN '202401' AND '202609' ORDER BY 2,1""").fetchall():
    prod_disp.append([r[0], r[1], round(float(r[2] or 0),2)])

prod_fcst = [[r[0], r[1], round(float(r[2] or 0),2)] for r in con.execute("""
    SELECT fc.material, fc.zmonth, SUM(fc.zbvalue)
    FROM fcst.sap_prd.fact_forecast fc
    JOIN top_mats t ON t.material = fc.material
    GROUP BY 1,2 ORDER BY 2,1""").fetchall()]
FCST_MONTH = max([r[1] for r in prod_fcst], default="")   # fact_forecast carries a single module month

# ---- customers: top 1500 by total sales, x month, + payment class (CASH = CSH1 / CREDIT) ----
# Payment class per customer = latest invoice term within the trailing 12 months (anchor =
# max inv_date in the fact). Row shape: [cust, name, ym, class, payment_terms, sales, returns, qty, inv, cogs].
ANCHOR = con.execute("SELECT max(inv_date) FROM f.sap_prd.fact_ztsd_detail").fetchone()[0]
CUTOFF = (ANCHOR - datetime.timedelta(days=365)).strftime("%Y-%m-%d")
cust_cls = {}
cust_pt = {}
for cust, pt in con.execute("""
    SELECT customer, payment_terms FROM (
      SELECT customer, payment_terms,
             ROW_NUMBER() OVER (PARTITION BY customer ORDER BY inv_date DESC) rn
      FROM f.sap_prd.fact_ztsd_detail
      WHERE inv_date >= DATE '%s'
        AND sale_org <> '6000' AND inv_type NOT IN ('ZAST','ZR1I','ZRTL','ZRTR')
    ) t WHERE rn = 1""" % CUTOFF).fetchall():
    cust_cls[cust] = 'CASH' if (pt or '') == 'CSH1' else 'CREDIT'
    cust_pt[cust] = (pt or '').strip()

cust_tot = {r[0] for r in con.execute("""
    SELECT customer, SUM(CASE WHEN zsign>=0 THEN net_value ELSE 0 END) s
    FROM cls GROUP BY 1 ORDER BY s DESC LIMIT 1500""").fetchall()}
cust_map = {r[0]: r[1] or "" for r in
            con.execute("SELECT customer, cus_name FROM cls GROUP BY 1,2").fetchall()}
customers = []
for cust, name, ym, sales, returns, qty, inv, cogs in con.execute("""
    SELECT customer, cus_name, ym,
           SUM(CASE WHEN zsign >= 0 THEN net_value ELSE 0 END),
           -SUM(CASE WHEN zsign < 0 THEN net_value ELSE 0 END),
           SUM(qty_in_sku),
           COUNT(DISTINCT inv_no),
           SUM(CASE WHEN zsign >= 0 THEN cost_price ELSE 0 END)
    FROM cls GROUP BY 1,2,3 ORDER BY ym""").fetchall():
    if cust in cust_tot:
        customers.append([cust, name or "", ym, cust_cls.get(cust, 'CASH'), cust_pt.get(cust, ''),
                          round(float(sales or 0),2), round(float(returns or 0),2),
                          round(float(qty or 0),0), int(inv or 0), round(float(cogs or 0),2)])

# ---- customer cash/credit KPI strip is now period-filterable ----
# The exec By Customer strip (Cash/Credit Customers, Credit Exposure, etc.) is computed on
# the CLIENT from DATA.customers (top-1500 x month) filtered by the global Year/Month filters,
# so it follows the selected period instead of a fixed trailing-12-month window. No separate
# cust_summary dataset is shipped anymore (leaner source).

# ---- reconcile ----
total_sales = sum(r[3] for r in rows)
total_returns = sum(r[4] for r in rows)
total_qty = sum(r[5] for r in rows)
total_inv = sum(r[6] for r in rows)
total_cogs = sum(r[7] for r in rows)
total_target = sum(t[2] for t in targets)
plants_used = len({r[1] for r in rows})
salesmen_n = len({s[0] for s in salesmen})
customers_n = len({c[0] for c in customers})

meta = {
    "generated_at": datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
    "source": "fact_ztsd_detail + fact_plant_sales_target + dim_plants + dim_ztso_details (duckdb, sap_prd, SAP ECC PRD)",
    "as_of": datetime.date.today().isoformat(),
    "currency": "SAR",
    "grain": "rows: ym x sales_office x segment (pre-aggregated from line-level fact); ext_grp: ym x plant x external material group; targets: plant x month; salesmen: emp x month; customers: top-1500 x month; products: top-1500-material x month (+ prod_info lookup, prod_foc / prod_disp / prod_fcst per material x month); customer cash/credit KPI strip is derived CLIENT-side from customers + the Year/Month filters",
    "total_sales": round(total_sales, 2),
    "total_returns": round(total_returns, 2),
    "total_qty": int(total_qty),
    "total_invoices": int(total_inv),
    "total_cogs": round(total_cogs, 2),
    "total_target": round(total_target, 2),
    "forecast_month": FCST_MONTH,
    "plants": plants_used,
    "salesmen": salesmen_n,
    "customers": customers_n,
    "walkin": "0001200000",
    "notes": [
        "sales_office IS the plant key (fact has no WERKS); join to dim_plants.werks.",
        "Segment is DERIVED from dim_plants.name2: Branch|Warehouse=B2B, Showroom=B2C, Horeca=HRC, Online=OLN. Plants payload index 5 carries this segment.",
        "EXCLUDED sale_org '6000' (Bakemate company, plants 6001/6002) from the whole payload.",
        "EXCLUDED invoice types 'ZAST', 'ZR1I', 'ZRTL', 'ZRTR' from the whole payload (user directive).",
        "sales = SUM(net_value) of Sales/Special invoice lines (zsign >= 0); returns = magnitude of Return lines (zsign < 0).",
        "cogs = SUM(cost_price) of Sales/Special lines (zsign >= 0). cost_price is the line-level cost of goods sold (not per-unit).",
        "net_value is net of returns; gross (grand_tot) not shipped.",
        "qty_in_sku is base/SKU units (never mix with order units).",
        "Ranges: zmonth 202401..202609. Target range 202312..202609.",
        "customers limited to top 1500 by total sales value (full list is ~hundreds of thousands). Each customers row is [cust, name, ym, class, payment_terms, sales, returns, qty, inv, cogs] where class = CASH (CSH1) or CREDIT (latest invoice term within the trailing 12 months); payment_terms = that latest term code; inv = distinct invoice count, cogs = SUM(cost_price) of Sales/Special lines (so GP = sales - cogs). The By Customer cash/credit KPI strip and donut are computed CLIENT-side from these filterable rows (follows the global Year/Month filters, NOT a fixed trailing-12-month window).",
        "meta.walkin (0001200000) is the synthetic retail-counter / walk-in catch-all customer, not a real company. The By Customer page always shows it (the show/hide toggle was removed 2026-09); its name carries a '(walk-in counter)' suffix.",
        "ext_grp rows = [ym, plant, mat_ext_grp, mat_ext_grp_des, sales, returns, cogs]; no target at material-group grain (target is plant-level only).",
        "foc rows = [ym, plant, amount] = Free-of-Goods cost from fact_foc (SUM(amount), ym from erdat). gdrn rows = [ym, plant, dmbtr] = Disposal value from fact_gdrn (SUM(dmbtr), ym from budat_mkpf). Both exclude Bakemate plants 6001/6002 to match the payload scope.",
                "products = [material, ym, sales, returns, qty, inv, cogs] = the top 1500 materials by total sales, at material x month (202401..202609) — period-filterable, reconciles with `rows` for those materials. prod_info = [material, mat_des, mat_ext_grp, mat_ext_grp_des] is the display lookup (one row per material; mat_des = dim_material_master.maktx (MAKT English) -- the canonical spelling; the fact\'s highest-sales spelling is only the fallback for the ~5 materials absent from the plant-2401-scoped master. mat_ext_grp / mat_ext_grp_des come from ZTSD_DETAIL (arg_max) so the By Product group column agrees with the exec/ext_grp tables). prod_foc / prod_disp = [material, ym, value] = SUM(fact_foc.amount) by erdat / SUM(fact_gdrn.dmbtr) by budat_mkpf, both excluding Bakemate plants 6001/6002; prod_fcst = [material, ym, SUM(fact_forecast.zbvalue)] — the forecast module carries ONE month (meta.forecast_month), so the Forecast column is only populated when the selected month = that month. GP = sales - cogs.",
    ],
}

payload = {"meta": meta, "rows": rows, "targets": targets, "plants": plants,
           "salesmen": salesmen, "customers": customers,
           "ext_grp": ext_grp,
           "foc": foc, "gdrn": gdrn, "products": products, "prod_info": prod_info,
           "prod_foc": prod_foc, "prod_disp": prod_disp, "prod_fcst": prod_fcst}

for path, as_js in [(OUT_JSON, False), (OUT_JS, True)]:
    with open(path, "w", encoding="utf-8") as fh:
        if as_js:
            fh.write("window.__SALES__ = ")
        json.dump(payload, fh, ensure_ascii=False, separators=(",", ":"))
        if as_js:
            fh.write(";")

print("rows:", len(rows), "| targets:", len(targets), "| plants:", len(plants),
      "| salesmen:", len(salesmen), "| customers:", len(customers), "| ext_grp:", len(ext_grp))
print("products:", len(products), "| prod_info:", len(prod_info), "| prod_foc:", len(prod_foc),
      "| prod_disp:", len(prod_disp), "| prod_fcst:", len(prod_fcst), "| forecast_month:", FCST_MONTH)
print("total sales:", round(total_sales, 2), "| returns:", round(total_returns, 2),
      "| qty:", int(total_qty), "| invoices:", int(total_inv), "| cogs:", round(total_cogs, 2),
      "| target:", round(total_target, 2))
print("File size bytes:", os.path.getsize(OUT_JSON))
print("DONE")
