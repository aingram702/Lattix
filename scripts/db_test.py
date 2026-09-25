#!/usr/bin/env python3
"""Database-layer regression tests (Lattix 2.2).

Covers what can't be driven over HTTP in a reasonable time: schema migration
from old databases, owner succession on account deletion, and immediate
cleanup of blobs behind expired disappearing messages.

    python3 scripts/db_test.py

Each test runs against its own throwaway database file. scripts/run_all_tests.mjs
runs this with the other suites.
"""

from __future__ import annotations

import importlib
import os
import sqlite3
import sys
import tempfile
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

passed = failed = 0


def ok(name: str, cond: bool, extra: str = "") -> None:
    global passed, failed
    if cond:
        passed += 1
        print("  ✓", name)
    else:
        failed += 1
        print("  ✗", name, extra)


def fresh_db(path: str):
    """Import server.database bound to `path` (it reads LATTIX_DB at import)."""
    os.environ["LATTIX_DB"] = path
    import server.database as db
    db = importlib.reload(db)
    return db


def add_user(db, name: str) -> None:
    db.create_user(name, "k", "d", "0" * 64, "00", "00")


print("\nLattix database tests\n=====================")
tmp = tempfile.mkdtemp(prefix="lattix-dbtest-")

# --------------------------------------------------------------------------
# 1. Migration from a 1.x database (no file_id / expires_at / avatar / icon)
# --------------------------------------------------------------------------
legacy = os.path.join(tmp, "legacy.db")
c = sqlite3.connect(legacy)
c.executescript("""
CREATE TABLE users (username TEXT PRIMARY KEY, kem_public_key TEXT NOT NULL,
  dsa_public_key TEXT NOT NULL, fingerprint TEXT NOT NULL, auth_salt TEXT NOT NULL,
  auth_hash TEXT NOT NULL, created_at REAL NOT NULL);
CREATE TABLE envelopes (id INTEGER PRIMARY KEY AUTOINCREMENT, sender TEXT NOT NULL,
  recipient TEXT NOT NULL, kind TEXT NOT NULL, payload TEXT NOT NULL, created_at REAL NOT NULL);
CREATE TABLE groups (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL,
  owner TEXT NOT NULL, created_at REAL NOT NULL);
CREATE TABLE group_envelopes (id INTEGER PRIMARY KEY AUTOINCREMENT, group_id INTEGER NOT NULL,
  sender TEXT NOT NULL, kind TEXT NOT NULL, payload TEXT NOT NULL, created_at REAL NOT NULL);
INSERT INTO users VALUES ('old', 'k', 'd', 'f', 's', 'h', 0);
""")
c.commit()
c.close()
db = fresh_db(legacy)
try:
    db.init_db()
    ok("a pre-file_id database migrates instead of crashing startup", True)
except Exception as e:  # noqa: BLE001
    ok("a pre-file_id database migrates instead of crashing startup", False, repr(e))
conn = sqlite3.connect(legacy)
cols = lambda t: {r[1] for r in conn.execute(f"PRAGMA table_info({t})")}  # noqa: E731
ok("envelopes gained file_id and expires_at", {"file_id", "expires_at"} <= cols("envelopes"))
ok("group_envelopes gained file_id and expires_at", {"file_id", "expires_at"} <= cols("group_envelopes"))
ok("groups gained icon, users gained avatar", "icon" in cols("groups") and "avatar" in cols("users"))
idx = {r[1] for r in conn.execute("PRAGMA index_list(envelopes)")}
ok("the file_id index exists after migration", "idx_env_file_id" in idx)
ok("existing rows survive", conn.execute("SELECT count(*) FROM users").fetchone()[0] == 1)
conn.close()
try:
    db.init_db()
    ok("running init_db twice is harmless", True)
except Exception as e:  # noqa: BLE001
    ok("running init_db twice is harmless", False, repr(e))

# --------------------------------------------------------------------------
# 2. Deleting a group owner's account hands the group over
# --------------------------------------------------------------------------
db = fresh_db(os.path.join(tmp, "owner.db"))
db.init_db()
for u in ("owner", "m1", "m2", "solo"):
    add_user(db, u)
g = db.create_group("team", "owner", [])
time.sleep(0.01)
db.add_group_member(g["id"], "m1")
time.sleep(0.01)
db.add_group_member(g["id"], "m2")
db.store_group_envelope(g["id"], "m1", "message", {"x": 1})
lonely = db.create_group("alone", "solo", [])

touched = db.delete_user("owner")
after = db.get_group(g["id"])
ok("the group survives its owner's account deletion", after is not None)
ok("ownership passes to the longest-standing member", after and after["owner"] == "m1")
ok("members' history survives", len(db.get_group_messages(g["id"])) == 1)
ok("delete_user reports the changed group", g["id"] in touched)
db.delete_user("solo")
ok("a group with nobody left is dropped", db.get_group(lonely["id"]) is None)

# --------------------------------------------------------------------------
# 3. Expired disappearing file messages take their blob with them
# --------------------------------------------------------------------------
db = fresh_db(os.path.join(tmp, "expire.db"))
db.init_db()
add_user(db, "a")
add_user(db, "b")
db.store_file("f" * 32, "a", b"cipher", 6)
db.store_envelope("a", "b", "file", {}, file_id="f" * 32, expires_at=time.time() - 1)
db.store_file("e" * 32, "a", b"cipher", 6)
db.store_envelope("a", "b", "file", {}, file_id="e" * 32, expires_at=None)
# A blob referenced by BOTH an expired and a live envelope must survive.
db.store_file("d" * 32, "a", b"cipher", 6)
db.store_envelope("a", "b", "file", {}, file_id="d" * 32, expires_at=time.time() - 1)
db.store_envelope("a", "b", "file", {}, file_id="d" * 32, expires_at=None)

removed = db.delete_expired()
ok("an expired file message's blob is deleted at once", db.get_file("f" * 32) is None)
ok("a live file message's blob is kept", db.get_file("e" * 32) is not None)
ok("a blob still referenced by a live message is kept", db.get_file("d" * 32) is not None)
ok("delete_expired reports one blob removed", removed == 1, f"got {removed}")

# --------------------------------------------------------------------------
# 4. History page size is the single constant the API advertises
# --------------------------------------------------------------------------
for i in range(db.HISTORY_PAGE_SIZE + 5):
    db.store_envelope("a", "b", "message", {"i": i})
page = db.get_conversation("a", "b")
ok("one history page is capped at HISTORY_PAGE_SIZE", len(page) == db.HISTORY_PAGE_SIZE)
rest = db.get_conversation("a", "b", since_id=page[-1]["id"])
ok("paging with since= returns the remainder", len(rest) >= 5)

print(f"\nResult: {passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
