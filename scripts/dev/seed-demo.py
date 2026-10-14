#!/usr/bin/env python3
"""Seed an isolated Table Pro Max data folder for screenshots.

Creates demo SQLite databases, one connection per environment, a restored workspace (one
SQLite connection with a table tab and a query tab) and the theme setting.

Usage: scripts/dev/seed-demo.py <app-data-dir> <light|dark> [active-tab-index]
<app-data-dir> is $XDG_DATA_HOME/dev.tablepromax.app of an isolated run. The app must have
started there once so app.db exists. Never point this at a real data folder.
"""
import datetime
import json
import pathlib
import sqlite3
import sys
import tempfile

data = pathlib.Path(sys.argv[1])
# Demo data only ever goes into scratch space: the repo's target/ folder or the temp folder.
_root = pathlib.Path(__file__).resolve().parents[2]
_allowed = [_root / "target", pathlib.Path(tempfile.gettempdir()).resolve()]
if not any(data.resolve().is_relative_to(a) for a in _allowed):
    sys.exit(f"seed-demo.py writes only under {_allowed[0]} or {_allowed[1]}, not {data.resolve()}")
theme = sys.argv[2]
active_tab = int(sys.argv[3]) if len(sys.argv) > 3 else 0
assert theme in ("light", "dark"), "theme must be light or dark"
app_db = data / "app.db"
assert app_db.exists(), f"{app_db} not found: start the app once with this data folder first"

demo = data / "demo"
demo.mkdir(exist_ok=True)
shop = demo / "shop.db"
if not shop.exists():
    c = sqlite3.connect(shop)
    c.executescript(
        """
        CREATE TABLE customers (id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT UNIQUE,
                                country TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
        CREATE TABLE orders (id INTEGER PRIMARY KEY, customer_id INTEGER REFERENCES customers(id),
                             status TEXT NOT NULL, total REAL, paid INTEGER, note TEXT, created_at TEXT);
        CREATE INDEX orders_customer ON orders(customer_id);
        CREATE VIEW paid_orders AS SELECT * FROM orders WHERE paid = 1;
        """
    )
    for i in range(1, 61):
        c.execute("INSERT INTO customers (name, email, country) VALUES (?, ?, ?)",
                  (f"Customer {i}", f"c{i}@example.com", ["IN", "US", "DE", "JP"][i % 4]))
    for i in range(1, 301):
        c.execute(
            "INSERT INTO orders (customer_id, status, total, paid, note, created_at) VALUES (?, ?, ?, ?, ?, ?)",
            (i % 60 + 1, ["DRAFT", "PAID", "SHIPPED", "CANCELLED"][i % 4], round(i * 3.7 % 500, 2),
             1 if i % 3 == 0 else 0, None if i % 5 else "gift", f"2026-09-{i % 28 + 1:02d} 10:{i % 60:02d}:00"),
        )
    c.commit()
    c.close()
for name in ("billing", "analytics", "audit", "warehouse"):
    path = demo / f"{name}.db"
    if not path.exists():
        sqlite3.connect(path).execute("CREATE TABLE IF NOT EXISTS t (id INTEGER PRIMARY KEY)").connection.close()


def profile(pid, name, env, path, safety="confirm_destructive"):
    return {
        "id": pid, "name": name, "driver": "sqlite", "filePath": str(path),
        "tls": {"mode": "disable", "caCertPath": None}, "passwordMode": "none",
        "environment": env, "safetyMode": safety, "color": None, "group": None, "tags": [],
        "connectTimeoutSecs": 10, "queryTimeoutSecs": 0, "keepaliveSecs": 60,
    }


profiles = [
    profile("demo-shop", "Shop (local)", "local", shop),
    profile("demo-billing", "Billing dev", "development", demo / "billing.db"),
    profile("demo-analytics", "Analytics test", "testing", demo / "analytics.db"),
    profile("demo-audit", "Audit staging", "staging", demo / "audit.db"),
    profile("demo-warehouse", "Warehouse prod", "production", demo / "warehouse.db", "read_only"),
]
now = datetime.datetime.now(datetime.timezone.utc).isoformat()
db = sqlite3.connect(app_db)
for order, p in enumerate(profiles, start=1):
    db.execute(
        "INSERT INTO connections (id, profile, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?) "
        "ON CONFLICT(id) DO UPDATE SET profile = excluded.profile",
        (p["id"], json.dumps(p), order, now, now),
    )
session = {
    "activeIndex": 0,
    "workspaces": [{
        "connectionId": "demo-shop", "database": "main", "schema": "main", "activeIndex": active_tab,
        "tabs": [
            {"kind": "table", "title": "orders", "schema": "main", "name": "orders", "objectKind": "table"},
            {"kind": "query", "title": "Query 1", "savedQueryId": None, "dirty": True,
             "sql": "SELECT c.name, count(*) AS orders, sum(o.total) AS spent\nFROM orders o\nJOIN customers c ON c.id = o.customer_id\nWHERE o.paid = 1\nGROUP BY c.name\nORDER BY spent DESC\nLIMIT 20;"},
        ],
    }],
}
for key, value in (("theme", theme), ("workspace.restore", True), ("updates.auto", "off")):
    db.execute("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
               (key, json.dumps(value)))
db.execute("INSERT INTO workspace (key, value, updated_at) VALUES ('session.v1', ?, ?) "
           "ON CONFLICT(key) DO UPDATE SET value = excluded.value", (json.dumps(session), now))
db.commit()
print(f"seeded {data}: theme={theme}, active tab={active_tab}")
