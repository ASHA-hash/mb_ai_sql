import os
import sys
from datetime import datetime

try:
    import pyodbc
except Exception as exc:
    print(f"pyodbc import failed: {exc}")
    sys.exit(2)


def load_env(path):
    env = {}
    with open(path, "r", encoding="utf-8") as f:
        for line in f:
            s = line.strip()
            if not s or s.startswith("#") or "=" not in s:
                continue
            k, v = s.split("=", 1)
            env[k.strip()] = v.strip().strip('"').strip("'")
    return env


def connect_from_env(env):
    server = env.get("DB_SERVER")
    port = env.get("DB_PORT", "1433")
    db = env.get("DB_NAME")
    user = env.get("DB_USER")
    pwd = env.get("DB_PASSWORD")
    if not all([server, db, user, pwd]):
        raise RuntimeError("Missing DB_* values in .env")

    drivers = ["ODBC Driver 18 for SQL Server", "ODBC Driver 17 for SQL Server", "SQL Server"]
    last_err = None
    for d in drivers:
        conn_str = (
            f"DRIVER={{{d}}};"
            f"SERVER={server},{port};DATABASE={db};UID={user};PWD={pwd};"
            "Encrypt=no;TrustServerCertificate=yes;"
        )
        try:
            conn = pyodbc.connect(conn_str, timeout=30)
            print(f"Connected using driver: {d}")
            return conn
        except Exception as exc:
            last_err = exc
    raise RuntimeError(f"Unable to connect with available drivers. Last error: {last_err}")


def main():
    root = os.path.dirname(os.path.dirname(__file__))
    env = load_env(os.path.join(root, ".env"))
    conn = connect_from_env(env)
    cur = conn.cursor()

    # Optional arguments:
    #   python scripts/verify_sales_returns.py 2026-04-01 2026-04-30 001
    from_date = sys.argv[1] if len(sys.argv) >= 2 else None
    to_date = sys.argv[2] if len(sys.argv) >= 3 else None
    branch_id = sys.argv[3] if len(sys.argv) >= 4 else None

    where = []
    params = []
    if from_date and to_date:
        where.append("CAST(InvoiceDt AS date) BETWEEN ? AND ?")
        params.extend([from_date, to_date])
    if branch_id:
        where.append("CAST(BranchId AS nvarchar(100)) = ?")
        params.append(branch_id)
    where_sql = ("WHERE " + " AND ".join(where)) if where else ""

    print("\n=== INPUT FILTERS ===")
    print(f"from_date={from_date or '(none)'}")
    print(f"to_date={to_date or '(none)'}")
    print(f"branch_id={branch_id or '(none)'}")

    summary_sql = f"""
    SELECT
      COUNT(1) AS TotalRows,
      SUM(CASE WHEN ISNULL(Quantity,0) > 0 THEN 1 ELSE 0 END) AS SalesRows,
      SUM(CASE WHEN ISNULL(Quantity,0) < 0 THEN 1 ELSE 0 END) AS ReturnRows,
      SUM(ISNULL(SaleNetAmount,0)) AS NetSalesAmount,
      SUM(CASE WHEN ISNULL(Quantity,0) > 0 THEN ISNULL(SaleNetAmount,0) ELSE 0 END) AS GrossSalesAmount,
      SUM(CASE WHEN ISNULL(Quantity,0) < 0 THEN ISNULL(SaleNetAmount,0) ELSE 0 END) AS ReturnsAmount
    FROM dbo.VwAISalesData
    {where_sql}
    """
    cur.execute(summary_sql, params)
    s = cur.fetchone()
    total_rows = int(s.TotalRows or 0)
    sales_rows = int(s.SalesRows or 0)
    return_rows = int(s.ReturnRows or 0)
    net_amt = float(s.NetSalesAmount or 0)
    gross_amt = float(s.GrossSalesAmount or 0)
    ret_amt = float(s.ReturnsAmount or 0)

    print("\n=== SUMMARY ===")
    print(f"TotalRows      : {total_rows}")
    print(f"SalesRows(+qty): {sales_rows}")
    print(f"ReturnRows(-qty): {return_rows}")
    print(f"GrossSalesAmount: {gross_amt:.2f} ({gross_amt/100000:.2f} L)")
    print(f"ReturnsAmount   : {ret_amt:.2f} ({ret_amt/100000:.2f} L)")
    print(f"NetSalesAmount  : {net_amt:.2f} ({net_amt/100000:.2f} L)")

    sample_sql = f"""
    SELECT TOP (20)
      InvoiceDt, InvoiceNo, BranchId, CustomerId, ItemId,
      SalesPrice, Quantity, SaleAmountBeforeTax, TaxAmount, SaleNetAmount
    FROM dbo.VwAISalesData
    {where_sql}
    ORDER BY CAST(InvoiceDt AS date) DESC, InvoiceNo DESC
    """
    cur.execute(sample_sql, params)
    rows = cur.fetchall()

    print("\n=== SAMPLE ROWS (top 20 by latest date) ===")
    for r in rows:
        dt = r.InvoiceDt
        if isinstance(dt, datetime):
            dt = dt.strftime("%Y-%m-%d")
        print(
            f"{dt} | {r.InvoiceNo} | Br={r.BranchId} | Qty={r.Quantity} | "
            f"Net={float(r.SaleNetAmount or 0):.2f}"
        )

    cur.close()
    conn.close()


if __name__ == "__main__":
    main()

