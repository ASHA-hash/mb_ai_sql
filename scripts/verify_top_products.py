import os
import re
import sys

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


def norm_item_name(raw):
    txt = str(raw or "").strip()
    txt = re.sub(r"\s+", " ", txt)
    return txt


def main():
    root = os.path.dirname(os.path.dirname(__file__))
    env = load_env(os.path.join(root, ".env"))
    server = env.get("DB_SERVER")
    port = env.get("DB_PORT", "1433")
    db = env.get("DB_NAME")
    user = env.get("DB_USER")
    pwd = env.get("DB_PASSWORD")
    if not all([server, db, user, pwd]):
        print("Missing DB_* values in .env")
        sys.exit(1)

    drivers = ["ODBC Driver 18 for SQL Server", "ODBC Driver 17 for SQL Server", "SQL Server"]
    conn = None
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
            break
        except Exception as exc:
            last_err = exc
    if conn is None:
        print(f"Unable to connect with available drivers. Last error: {last_err}")
        print("Installed ODBC drivers:", pyodbc.drivers())
        sys.exit(3)
    cur = conn.cursor()

    cur.execute(
        """
        SELECT COLUMN_NAME
        FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_SCHEMA='dbo' AND TABLE_NAME='VwMstItems'
        ORDER BY ORDINAL_POSITION
        """
    )
    item_cols = [r[0] for r in cur.fetchall()]
    item_set = {c.lower() for c in item_cols}
    name_candidates = ["ProductName", "Description", "ItemName", "ArticleShortName", "ArticleName", "ArticleNo"]
    name_col = next((c for c in name_candidates if c.lower() in item_set), None)
    if not name_col:
        print("No readable item-name column found in dbo.VwMstItems.")
        print("Available columns:", item_cols)
        sys.exit(4)

    print(f"Using item name column: {name_col}")

    query = f"""
    SELECT TOP (10)
      ISNULL(NULLIF(LTRIM(RTRIM(i.[{name_col}])), ''), 'Unknown') AS ProductName,
      SUM(ISNULL(s.SaleNetAmount, 0)) AS TotalSales
    FROM dbo.VwAISalesData s
    INNER JOIN dbo.VwMstItems i ON s.ItemId = i.ItemId
    GROUP BY ISNULL(NULLIF(LTRIM(RTRIM(i.[{name_col}])), ''), 'Unknown')
    HAVING SUM(ISNULL(s.SaleNetAmount, 0)) > 0
    ORDER BY TotalSales DESC
    """
    cur.execute(query)
    rows = cur.fetchall()

    print(f"rows={len(rows)}")
    for idx, row in enumerate(rows, start=1):
        name = norm_item_name(row[0])
        total = float(row[1] or 0.0)
        print(f"{idx:02d}. {name} | {total:.2f} | {total/100000:.2f} L")

    cur.close()
    conn.close()


if __name__ == "__main__":
    main()
