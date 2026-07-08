"""
Lattix — SQLite storage layer.

The server is a *zero-knowledge relay*: it stores public keys, opaque
encrypted envelopes, and encrypted file blobs. It never sees plaintext,
private keys, or shared secrets. All cryptography happens on the clients.
"""

from __future__ import annotations

import sqlite3
import threading
import time
import json
import os
from typing import Any, Optional

_DB_PATH = os.environ.get(
    "LATTIX_DB",
    os.path.join(os.path.dirname(os.path.dirname(__file__)), "data", "lattix.db"),
)

# A single connection guarded by a lock keeps things simple and correct for a
# local, single-process deployment. For high concurrency, swap in a pool.
_lock = threading.RLock()
_conn: Optional[sqlite3.Connection] = None


def _connect() -> sqlite3.Connection:
    global _conn
    if _conn is None:
        os.makedirs(os.path.dirname(_DB_PATH), exist_ok=True)
        _conn = sqlite3.connect(_DB_PATH, check_same_thread=False)
        _conn.row_factory = sqlite3.Row
        _conn.execute("PRAGMA journal_mode=WAL;")
        _conn.execute("PRAGMA foreign_keys=ON;")
    return _conn


def init_db() -> None:
    with _lock:
        conn = _connect()
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS users (
                username         TEXT PRIMARY KEY,
                kem_public_key   TEXT NOT NULL,   -- base64 ML-KEM-768 public key
                dsa_public_key   TEXT NOT NULL,   -- base64 ML-DSA-65 public key
                fingerprint      TEXT NOT NULL,   -- hex SHA-256 of pubkeys (identity)
                auth_salt        TEXT NOT NULL,   -- hex salt for the login secret
                auth_hash        TEXT NOT NULL,   -- hex PBKDF2 of the login secret
                created_at       REAL NOT NULL
            );

            CREATE TABLE IF NOT EXISTS envelopes (
                id           INTEGER PRIMARY KEY AUTOINCREMENT,
                sender       TEXT NOT NULL,
                recipient    TEXT NOT NULL,
                kind         TEXT NOT NULL,        -- 'message' | 'file'
                payload      TEXT NOT NULL,        -- opaque JSON (ciphertext, kem_ct, sig...)
                created_at   REAL NOT NULL,
                FOREIGN KEY (sender)    REFERENCES users(username) ON DELETE CASCADE,
                FOREIGN KEY (recipient) REFERENCES users(username) ON DELETE CASCADE
            );
            CREATE INDEX IF NOT EXISTS idx_env_recipient ON envelopes(recipient, id);
            CREATE INDEX IF NOT EXISTS idx_env_sender    ON envelopes(sender, id);

            CREATE TABLE IF NOT EXISTS files (
                id           TEXT PRIMARY KEY,     -- uuid
                owner        TEXT NOT NULL,        -- uploader username
                ciphertext   BLOB NOT NULL,        -- AES-GCM ciphertext (server can't read)
                size         INTEGER NOT NULL,     -- plaintext size in bytes (metadata only)
                created_at   REAL NOT NULL,
                FOREIGN KEY (owner) REFERENCES users(username) ON DELETE CASCADE
            );
            """
        )
        conn.commit()


# ----------------------------------------------------------------------------
# Users / key directory
# ----------------------------------------------------------------------------

def create_user(
    username: str,
    kem_public_key: str,
    dsa_public_key: str,
    fingerprint: str,
    auth_salt: str,
    auth_hash: str,
) -> None:
    with _lock:
        conn = _connect()
        conn.execute(
            "INSERT INTO users (username, kem_public_key, dsa_public_key, fingerprint,"
            " auth_salt, auth_hash, created_at) VALUES (?,?,?,?,?,?,?)",
            (username, kem_public_key, dsa_public_key, fingerprint,
             auth_salt, auth_hash, time.time()),
        )
        conn.commit()


def get_user(username: str) -> Optional[dict[str, Any]]:
    with _lock:
        conn = _connect()
        row = conn.execute(
            "SELECT * FROM users WHERE username = ?", (username,)
        ).fetchone()
        return dict(row) if row else None


def user_exists(username: str) -> bool:
    return get_user(username) is not None


def search_users(query: str, limit: int = 25) -> list[dict[str, Any]]:
    with _lock:
        conn = _connect()
        rows = conn.execute(
            "SELECT username, fingerprint FROM users WHERE username LIKE ? "
            "ORDER BY username LIMIT ?",
            (f"%{query}%", limit),
        ).fetchall()
        return [dict(r) for r in rows]


# ----------------------------------------------------------------------------
# Envelopes (encrypted messages / file notifications)
# ----------------------------------------------------------------------------

def store_envelope(sender: str, recipient: str, kind: str, payload: dict) -> dict:
    with _lock:
        conn = _connect()
        now = time.time()
        cur = conn.execute(
            "INSERT INTO envelopes (sender, recipient, kind, payload, created_at)"
            " VALUES (?,?,?,?,?)",
            (sender, recipient, kind, json.dumps(payload), now),
        )
        conn.commit()
        return {
            "id": cur.lastrowid,
            "sender": sender,
            "recipient": recipient,
            "kind": kind,
            "payload": payload,
            "created_at": now,
        }


def get_conversation(user_a: str, user_b: str, since_id: int = 0,
                     limit: int = 500) -> list[dict]:
    """All envelopes exchanged between two users, oldest first."""
    with _lock:
        conn = _connect()
        rows = conn.execute(
            "SELECT * FROM envelopes WHERE id > ? AND "
            "((sender = ? AND recipient = ?) OR (sender = ? AND recipient = ?)) "
            "ORDER BY id ASC LIMIT ?",
            (since_id, user_a, user_b, user_b, user_a, limit),
        ).fetchall()
        return [_row_to_envelope(r) for r in rows]


def get_inbox(recipient: str, since_id: int = 0, limit: int = 1000) -> list[dict]:
    """Everything addressed to a user, across all conversations."""
    with _lock:
        conn = _connect()
        rows = conn.execute(
            "SELECT * FROM envelopes WHERE recipient = ? AND id > ? "
            "ORDER BY id ASC LIMIT ?",
            (recipient, since_id, limit),
        ).fetchall()
        return [_row_to_envelope(r) for r in rows]


def list_contacts(username: str) -> list[str]:
    """Distinct usernames this user has exchanged envelopes with."""
    with _lock:
        conn = _connect()
        rows = conn.execute(
            "SELECT DISTINCT peer FROM ("
            "  SELECT recipient AS peer FROM envelopes WHERE sender = ? "
            "  UNION "
            "  SELECT sender AS peer FROM envelopes WHERE recipient = ?"
            ")",
            (username, username),
        ).fetchall()
        return [r["peer"] for r in rows if r["peer"] != username]


def _row_to_envelope(r: sqlite3.Row) -> dict:
    return {
        "id": r["id"],
        "sender": r["sender"],
        "recipient": r["recipient"],
        "kind": r["kind"],
        "payload": json.loads(r["payload"]),
        "created_at": r["created_at"],
    }


# ----------------------------------------------------------------------------
# Encrypted file blobs
# ----------------------------------------------------------------------------

def store_file(file_id: str, owner: str, ciphertext: bytes, size: int) -> None:
    with _lock:
        conn = _connect()
        conn.execute(
            "INSERT INTO files (id, owner, ciphertext, size, created_at) VALUES (?,?,?,?,?)",
            (file_id, owner, ciphertext, size, time.time()),
        )
        conn.commit()


def get_file(file_id: str) -> Optional[dict]:
    with _lock:
        conn = _connect()
        row = conn.execute("SELECT * FROM files WHERE id = ?", (file_id,)).fetchone()
        if not row:
            return None
        return {
            "id": row["id"],
            "owner": row["owner"],
            "ciphertext": row["ciphertext"],
            "size": row["size"],
            "created_at": row["created_at"],
        }
