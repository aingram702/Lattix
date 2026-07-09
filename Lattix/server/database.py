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
                avatar           TEXT,            -- small profile image (data URL)
                created_at       REAL NOT NULL
            );

            CREATE TABLE IF NOT EXISTS envelopes (
                id           INTEGER PRIMARY KEY AUTOINCREMENT,
                sender       TEXT NOT NULL,
                recipient    TEXT NOT NULL,
                kind         TEXT NOT NULL,        -- 'message' | 'file'
                payload      TEXT NOT NULL,        -- opaque JSON (ciphertext, kem_ct, sig...)
                file_id      TEXT,                 -- set for kind='file'; links to files.id
                expires_at   REAL,                 -- disappearing-message deadline (NULL = keep)
                created_at   REAL NOT NULL,
                FOREIGN KEY (sender)    REFERENCES users(username) ON DELETE CASCADE,
                FOREIGN KEY (recipient) REFERENCES users(username) ON DELETE CASCADE
            );
            CREATE INDEX IF NOT EXISTS idx_env_recipient ON envelopes(recipient, id);
            CREATE INDEX IF NOT EXISTS idx_env_sender    ON envelopes(sender, id);
            CREATE INDEX IF NOT EXISTS idx_env_file_id   ON envelopes(file_id);

            CREATE TABLE IF NOT EXISTS files (
                id           TEXT PRIMARY KEY,     -- uuid
                owner        TEXT NOT NULL,        -- uploader username
                ciphertext   BLOB NOT NULL,        -- AES-GCM ciphertext (server can't read)
                size         INTEGER NOT NULL,     -- plaintext size in bytes (metadata only)
                created_at   REAL NOT NULL,
                FOREIGN KEY (owner) REFERENCES users(username) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS groups (
                id           INTEGER PRIMARY KEY AUTOINCREMENT,
                name         TEXT NOT NULL,
                icon         TEXT,                 -- emoji or small data URL
                owner        TEXT NOT NULL,
                created_at   REAL NOT NULL,
                FOREIGN KEY (owner) REFERENCES users(username) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS group_members (
                group_id     INTEGER NOT NULL,
                username     TEXT NOT NULL,
                joined_at    REAL NOT NULL,
                PRIMARY KEY (group_id, username),
                FOREIGN KEY (group_id) REFERENCES groups(id)     ON DELETE CASCADE,
                FOREIGN KEY (username) REFERENCES users(username) ON DELETE CASCADE
            );
            CREATE INDEX IF NOT EXISTS idx_gm_user ON group_members(username);

            CREATE TABLE IF NOT EXISTS group_envelopes (
                id           INTEGER PRIMARY KEY AUTOINCREMENT,
                group_id     INTEGER NOT NULL,
                sender       TEXT NOT NULL,
                kind         TEXT NOT NULL,        -- 'message' | 'file'
                payload      TEXT NOT NULL,
                file_id      TEXT,
                expires_at   REAL,
                created_at   REAL NOT NULL,
                FOREIGN KEY (group_id) REFERENCES groups(id)     ON DELETE CASCADE,
                FOREIGN KEY (sender)   REFERENCES users(username) ON DELETE CASCADE
            );
            CREATE INDEX IF NOT EXISTS idx_ge_group ON group_envelopes(group_id, id);
            CREATE INDEX IF NOT EXISTS idx_ge_file  ON group_envelopes(file_id);
            """
        )
        _migrate(conn)
        conn.commit()


def _migrate(conn: sqlite3.Connection) -> None:
    """Add columns introduced after the first schema without dropping data."""
    env_cols = {r["name"] for r in conn.execute("PRAGMA table_info(envelopes)")}
    if "file_id" not in env_cols:
        conn.execute("ALTER TABLE envelopes ADD COLUMN file_id TEXT")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_env_file_id ON envelopes(file_id)")
    if "expires_at" not in env_cols:
        conn.execute("ALTER TABLE envelopes ADD COLUMN expires_at REAL")
    user_cols = {r["name"] for r in conn.execute("PRAGMA table_info(users)")}
    if "avatar" not in user_cols:
        conn.execute("ALTER TABLE users ADD COLUMN avatar TEXT")


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
    avatar: Optional[str] = None,
) -> None:
    with _lock:
        conn = _connect()
        conn.execute(
            "INSERT INTO users (username, kem_public_key, dsa_public_key, fingerprint,"
            " auth_salt, auth_hash, avatar, created_at) VALUES (?,?,?,?,?,?,?,?)",
            (username, kem_public_key, dsa_public_key, fingerprint,
             auth_salt, auth_hash, avatar, time.time()),
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


def set_avatar(username: str, avatar: Optional[str]) -> None:
    with _lock:
        conn = _connect()
        conn.execute("UPDATE users SET avatar = ? WHERE username = ?", (avatar, username))
        conn.commit()


def delete_user(username: str) -> None:
    """Remove a user and everything owned by them. Foreign-key cascades take
    care of their envelopes, files, group memberships, and owned groups."""
    with _lock:
        conn = _connect()
        conn.execute("DELETE FROM users WHERE username = ?", (username,))
        conn.commit()


def search_users(query: str, limit: int = 25) -> list[dict[str, Any]]:
    with _lock:
        conn = _connect()
        # Escape SQL LIKE wildcards in user input so a search for e.g. "%" or
        # "_" doesn't behave as a wildcard match instead of a literal search.
        escaped = query.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
        rows = conn.execute(
            "SELECT username, fingerprint, avatar FROM users WHERE username LIKE ? ESCAPE '\\' "
            "ORDER BY username LIMIT ?",
            (f"%{escaped}%", limit),
        ).fetchall()
        return [dict(r) for r in rows]


# ----------------------------------------------------------------------------
# Envelopes (encrypted messages / file notifications)
# ----------------------------------------------------------------------------

def store_envelope(
    sender: str, recipient: str, kind: str, payload: dict,
    file_id: Optional[str] = None, expires_at: Optional[float] = None,
) -> dict:
    with _lock:
        conn = _connect()
        now = time.time()
        cur = conn.execute(
            "INSERT INTO envelopes (sender, recipient, kind, payload, file_id, expires_at, created_at)"
            " VALUES (?,?,?,?,?,?,?)",
            (sender, recipient, kind, json.dumps(payload), file_id, expires_at, now),
        )
        conn.commit()
        return {
            "id": cur.lastrowid,
            "sender": sender,
            "recipient": recipient,
            "kind": kind,
            "payload": payload,
            "expires_at": expires_at,
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
            "AND (expires_at IS NULL OR expires_at > ?) "
            "ORDER BY id ASC LIMIT ?",
            (since_id, user_a, user_b, user_b, user_a, time.time(), limit),
        ).fetchall()
        return [_row_to_envelope(r) for r in rows]


def get_inbox(recipient: str, since_id: int = 0, limit: int = 1000) -> list[dict]:
    """Everything addressed to a user, across all conversations."""
    with _lock:
        conn = _connect()
        rows = conn.execute(
            "SELECT * FROM envelopes WHERE recipient = ? AND id > ? "
            "AND (expires_at IS NULL OR expires_at > ?) "
            "ORDER BY id ASC LIMIT ?",
            (recipient, since_id, time.time(), limit),
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


def delete_expired() -> None:
    """Drop disappearing messages whose deadline has passed."""
    with _lock:
        conn = _connect()
        now = time.time()
        conn.execute("DELETE FROM envelopes WHERE expires_at IS NOT NULL AND expires_at <= ?", (now,))
        conn.execute("DELETE FROM group_envelopes WHERE expires_at IS NOT NULL AND expires_at <= ?", (now,))
        conn.commit()


def _row_to_envelope(r: sqlite3.Row) -> dict:
    return {
        "id": r["id"],
        "sender": r["sender"],
        "recipient": r["recipient"],
        "kind": r["kind"],
        "payload": json.loads(r["payload"]),
        "expires_at": r["expires_at"],
        "created_at": r["created_at"],
    }


# ----------------------------------------------------------------------------
# Groups
# ----------------------------------------------------------------------------

def create_group(name: str, owner: str, members: list[str], icon: Optional[str] = None) -> dict:
    with _lock:
        conn = _connect()
        now = time.time()
        cur = conn.execute(
            "INSERT INTO groups (name, icon, owner, created_at) VALUES (?,?,?,?)",
            (name, icon, owner, now),
        )
        gid = cur.lastrowid
        roster = {owner, *members}
        for u in roster:
            conn.execute(
                "INSERT OR IGNORE INTO group_members (group_id, username, joined_at) VALUES (?,?,?)",
                (gid, u, now),
            )
        conn.commit()
        return get_group(gid)


def get_group(group_id: int) -> Optional[dict]:
    with _lock:
        conn = _connect()
        row = conn.execute("SELECT * FROM groups WHERE id = ?", (group_id,)).fetchone()
        if not row:
            return None
        members = conn.execute(
            "SELECT u.username, u.kem_public_key, u.dsa_public_key, u.fingerprint, u.avatar "
            "FROM group_members gm JOIN users u ON u.username = gm.username "
            "WHERE gm.group_id = ? ORDER BY u.username",
            (group_id,),
        ).fetchall()
        return {
            "id": row["id"],
            "name": row["name"],
            "icon": row["icon"],
            "owner": row["owner"],
            "created_at": row["created_at"],
            "members": [dict(m) for m in members],
        }


def list_groups(username: str) -> list[dict]:
    with _lock:
        conn = _connect()
        rows = conn.execute(
            "SELECT g.id, g.name, g.icon, g.owner FROM groups g "
            "JOIN group_members gm ON gm.group_id = g.id WHERE gm.username = ? "
            "ORDER BY g.id",
            (username,),
        ).fetchall()
        return [dict(r) for r in rows]


def is_group_member(group_id: int, username: str) -> bool:
    with _lock:
        conn = _connect()
        row = conn.execute(
            "SELECT 1 FROM group_members WHERE group_id = ? AND username = ?",
            (group_id, username),
        ).fetchone()
        return row is not None


def group_member_names(group_id: int) -> list[str]:
    with _lock:
        conn = _connect()
        rows = conn.execute(
            "SELECT username FROM group_members WHERE group_id = ?", (group_id,)
        ).fetchall()
        return [r["username"] for r in rows]


def add_group_member(group_id: int, username: str) -> None:
    with _lock:
        conn = _connect()
        conn.execute(
            "INSERT OR IGNORE INTO group_members (group_id, username, joined_at) VALUES (?,?,?)",
            (group_id, username, time.time()),
        )
        conn.commit()


def remove_group_member(group_id: int, username: str) -> None:
    with _lock:
        conn = _connect()
        conn.execute(
            "DELETE FROM group_members WHERE group_id = ? AND username = ?",
            (group_id, username),
        )
        conn.commit()


def store_group_envelope(
    group_id: int, sender: str, kind: str, payload: dict,
    file_id: Optional[str] = None, expires_at: Optional[float] = None,
) -> dict:
    with _lock:
        conn = _connect()
        now = time.time()
        cur = conn.execute(
            "INSERT INTO group_envelopes (group_id, sender, kind, payload, file_id, expires_at, created_at)"
            " VALUES (?,?,?,?,?,?,?)",
            (group_id, sender, kind, json.dumps(payload), file_id, expires_at, now),
        )
        conn.commit()
        return {
            "id": cur.lastrowid,
            "group_id": group_id,
            "sender": sender,
            "kind": kind,
            "payload": payload,
            "expires_at": expires_at,
            "created_at": now,
        }


def get_group_messages(group_id: int, since_id: int = 0, limit: int = 500) -> list[dict]:
    with _lock:
        conn = _connect()
        rows = conn.execute(
            "SELECT * FROM group_envelopes WHERE group_id = ? AND id > ? "
            "AND (expires_at IS NULL OR expires_at > ?) ORDER BY id ASC LIMIT ?",
            (group_id, since_id, time.time(), limit),
        ).fetchall()
        return [_row_to_group_envelope(r) for r in rows]


def _row_to_group_envelope(r: sqlite3.Row) -> dict:
    return {
        "id": r["id"],
        "group_id": r["group_id"],
        "sender": r["sender"],
        "kind": r["kind"],
        "payload": json.loads(r["payload"]),
        "expires_at": r["expires_at"],
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


def user_can_access_file(username: str, file_id: str) -> bool:
    """A user may fetch a file blob only if they uploaded it, it was sent to
    (or by) them in a 1:1 file message, or it belongs to a group message in a
    group they are a member of. Prevents downloading arbitrary files by
    guessing/observing a file_id (IDOR)."""
    with _lock:
        conn = _connect()
        row = conn.execute(
            "SELECT 1 FROM files WHERE id = ? AND owner = ? "
            "UNION "
            "SELECT 1 FROM envelopes WHERE file_id = ? AND (sender = ? OR recipient = ?) "
            "UNION "
            "SELECT 1 FROM group_envelopes ge JOIN group_members gm ON gm.group_id = ge.group_id "
            "  WHERE ge.file_id = ? AND gm.username = ? "
            "LIMIT 1",
            (file_id, username, file_id, username, username, file_id, username),
        ).fetchone()
        return row is not None


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
