"""
Lattix relay server.

Architecture / trust model
--------------------------
Lattix is end-to-end encrypted. The server is a *dumb, zero-knowledge relay*:

  * It stores each user's PUBLIC keys (ML-KEM-768 + ML-DSA-65) in a directory.
  * It stores and forwards opaque encrypted envelopes (1:1 and group).
  * It stores encrypted file blobs it cannot read.

The server never sees plaintext, private keys, or shared secrets, and it cannot
forge messages because it does not hold any user's ML-DSA signing key. Message
authenticity is verified *client-to-client*: every envelope is signed by the
sender's ML-DSA identity key and verified by the recipient against the sender's
published public key. Users can compare key fingerprints out-of-band to defeat
directory-substitution (man-in-the-middle) attacks.

Account authentication (the login token) is intentionally decoupled from the
E2E keys: it only gates who may push to the relay under a given username. It is
NOT the root of trust for message security.
"""

from __future__ import annotations

import asyncio
import contextlib
import hashlib
import json
import os
import secrets
import sqlite3
import time
import uuid
from collections import defaultdict, deque
from contextlib import asynccontextmanager
from typing import Optional

from fastapi import (
    FastAPI, HTTPException, Depends, Header, Request, UploadFile, File, Form,
    WebSocket, WebSocketDisconnect,
)
from fastapi.responses import Response, FileResponse, PlainTextResponse
from fastapi.staticfiles import StaticFiles

from . import __version__
from . import database as db
from .models import (
    RegisterRequest, LoginRequest, PublicUser, SendMessageRequest,
    SendFileMessageRequest, TokenResponse, AvatarRequest, CreateGroupRequest,
    AddMemberRequest, GroupMessageRequest, GroupFileMessageRequest,
)

# --------------------------------------------------------------------------- #
# Config
# --------------------------------------------------------------------------- #
CLIENT_DIR = os.environ.get("LATTIX_CLIENT_DIR") or \
    os.path.join(os.path.dirname(os.path.dirname(__file__)), "client")
FILE_READ_CHUNK = 1024 * 1024
TOKEN_TTL = 60 * 60 * 12  # 12 hours
PBKDF2_ITERS = 200_000
# How often the background sweep runs, and how long an uploaded blob that no
# message references yet is kept before it is treated as abandoned. The grace
# period matters because /api/files is uploaded *before* the message that
# points at it is posted.
SWEEP_INTERVAL = 60
ORPHAN_FILE_GRACE = 6 * 60 * 60  # 6 hours
# How long a WebSocket may stay open without authenticating (see /ws).
WS_AUTH_TIMEOUT = 10
# A dummy salt used to run the password hash on a non-existent user too, so
# login timing doesn't reveal whether a username exists.
_DUMMY_LOGIN_SALT = secrets.token_hex(16)

# API docs (/api/docs) can be disabled in production by setting LATTIX_DOCS_URL="".
_DOCS_URL = os.environ.get("LATTIX_DOCS_URL", "/api/docs") or None


def _env_int(name: str, default: int, minimum: int = 1) -> int:
    """Read a positive integer from the environment, ignoring junk values."""
    try:
        value = int(os.environ.get(name, "").strip() or default)
    except ValueError:
        return default
    return value if value >= minimum else default


MAX_FILE_BYTES = _env_int("LATTIX_MAX_FILE_MB", 50) * 1024 * 1024


@asynccontextmanager
async def lifespan(_app: FastAPI):
    db.init_db()
    sweeper = asyncio.create_task(_sweep_loop())
    try:
        yield
    finally:
        sweeper.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await sweeper


# One switch for all of it: FastAPI also serves /redoc and /openapi.json by
# default, so hiding only /api/docs used to leave the schema public anyway.
# The schema lives under /api/ so it gets the API's no-store cache header.
app = FastAPI(
    title="Lattix", version=__version__, lifespan=lifespan,
    docs_url=_DOCS_URL, redoc_url=None,
    openapi_url="/api/openapi.json" if _DOCS_URL else None,
)

# --------------------------------------------------------------------------- #
# CORS — letting remote clients reach this relay
# --------------------------------------------------------------------------- #
# The web app this relay serves is same-origin and needs no CORS. Two kinds of
# client are NOT same-origin and would otherwise be blocked by the browser when
# they point at a remote relay (e.g. one on a VPS behind Caddy/nginx):
#
#   * the desktop apps, which open the UI from their local relay at
#     http://localhost:8000 (or 127.0.0.1), and
#   * the Chrome extension (chrome-extension://<32-char id>).
#
# Those origins are allowed by default. That is safe because authentication is
# a bearer token the client attaches itself — there are no cookies, so a page
# can't ride on anyone's session (allow_credentials stays False).
#
#   LATTIX_CORS_ORIGINS      extra comma-separated origins, or "*" for any
#                            (e.g. "https://chat.example.com")
#   LATTIX_CORS_ALLOW_LOCAL  "0" to stop allowing the desktop/extension origins
_LOCAL_ORIGIN_REGEX = (
    r"^(?:https?://(?:localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?"
    r"|chrome-extension://[a-p]{32})$"
)
_cors_origins = [o.strip().rstrip("/") for o in
                 os.environ.get("LATTIX_CORS_ORIGINS", "").split(",") if o.strip()]
_cors_allow_local = os.environ.get("LATTIX_CORS_ALLOW_LOCAL", "1").strip().lower() \
    not in ("0", "false", "no", "off")
if _cors_origins or _cors_allow_local:
    from fastapi.middleware.cors import CORSMiddleware
    app.add_middleware(
        CORSMiddleware,
        allow_origins=_cors_origins,
        allow_origin_regex=_LOCAL_ORIGIN_REGEX if _cors_allow_local else None,
        allow_methods=["GET", "POST", "PUT", "DELETE", "OPTIONS"],
        allow_headers=["Authorization", "Content-Type"],
        expose_headers=["X-Plaintext-Size"],
        allow_credentials=False,
        # Every authenticated JSON call is "non-simple" and costs a preflight
        # round trip. Through a reverse proxy on a distant VPS that doubles
        # request latency, so let the browser cache the answer (Chromium caps
        # this at 2 hours).
        max_age=7200,
    )


class _CacheHeaders:
    """Keep shared caches (reverse proxies, CDNs) from storing API responses —
    they carry per-user ciphertext and directory data — and make the static
    client revalidate, so a redeployed relay's UI is picked up at once instead
    of an old app.js lingering in a cache in front of it.

    Plain ASGI rather than @app.middleware("http"): BaseHTTPMiddleware re-wraps
    every response body, which is wasted work on multi-megabyte file blobs."""

    def __init__(self, app) -> None:
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        value = b"no-store" if scope.get("path", "").startswith("/api/") else b"no-cache"

        async def send_wrapper(message):
            if message["type"] == "http.response.start":
                headers = list(message.get("headers", []))
                if not any(k.lower() == b"cache-control" for k, _ in headers):
                    headers.append((b"cache-control", value))
                message["headers"] = headers
            await send(message)

        await self.app(scope, receive, send_wrapper)


app.add_middleware(_CacheHeaders)


async def _sweep_loop() -> None:
    """Periodically purge disappearing messages whose deadline has passed, and
    the encrypted blobs left behind by file messages that have gone with them."""
    while True:
        try:
            await asyncio.to_thread(db.delete_expired)
            await asyncio.to_thread(db.delete_orphan_files, ORPHAN_FILE_GRACE)
        except Exception:
            pass
        await asyncio.sleep(SWEEP_INTERVAL)


def _expiry(ttl: Optional[int]) -> Optional[float]:
    return time.time() + ttl if ttl else None


# --------------------------------------------------------------------------- #
# Token store (in-memory; fine for a single-process deployment)
# --------------------------------------------------------------------------- #
_tokens: dict[str, dict] = {}  # token -> {username, expires_at}


def _issue_token(username: str) -> TokenResponse:
    now = time.time()
    # Opportunistically sweep expired tokens so the store doesn't grow forever.
    for t, rec in list(_tokens.items()):
        if rec["expires_at"] < now:
            _tokens.pop(t, None)
    token = secrets.token_urlsafe(32)
    expires_at = now + TOKEN_TTL
    _tokens[token] = {"username": username, "expires_at": expires_at}
    return TokenResponse(token=token, username=username, expires_at=expires_at)


def _resolve_token(token: str) -> Optional[str]:
    rec = _tokens.get(token)
    if not rec:
        return None
    if rec["expires_at"] < time.time():
        _tokens.pop(token, None)
        return None
    return rec["username"]


def require_user(authorization: str = Header(default="")) -> str:
    """FastAPI dependency: extract & validate the bearer token."""
    if not authorization.startswith("Bearer "):
        raise HTTPException(401, "Missing bearer token")
    username = _resolve_token(authorization[7:])
    if not username:
        raise HTTPException(401, "Invalid or expired token")
    return username


# --------------------------------------------------------------------------- #
# Auth helpers
# --------------------------------------------------------------------------- #
def _hash_secret(secret: str, salt_hex: str) -> str:
    dk = hashlib.pbkdf2_hmac(
        "sha256", secret.encode(), bytes.fromhex(salt_hex), PBKDF2_ITERS
    )
    return dk.hex()


# --------------------------------------------------------------------------- #
# Basic in-memory rate limiting for auth endpoints (per-IP sliding window)
# --------------------------------------------------------------------------- #
# A whole household or office shares one public IP behind NAT, so the defaults
# are deliberately overridable — ten sign-ins per five minutes is tight for a
# family relay, and a test suite blows through it in seconds.
#
#   LATTIX_RATE_LIMIT_MAX      attempts per window per (scope, ip)   [10]
#   LATTIX_RATE_LIMIT_WINDOW   window length in seconds              [300]
#   LATTIX_RATE_LIMIT_MAX=0    disables auth rate limiting entirely
RATE_LIMIT_WINDOW = _env_int("LATTIX_RATE_LIMIT_WINDOW", 300)
RATE_LIMIT_MAX = _env_int("LATTIX_RATE_LIMIT_MAX", 10, minimum=0)
# Stop the bucket map from growing without bound: a relay on the open internet
# is scanned by a lot of distinct IPs, and every one of them used to leave an
# entry behind forever.
RATE_BUCKET_LIMIT = 10_000

_rate_buckets: dict[str, deque] = defaultdict(deque)


def _prune_rate_buckets(now: float) -> None:
    for key, bucket in list(_rate_buckets.items()):
        while bucket and now - bucket[0] > RATE_LIMIT_WINDOW:
            bucket.popleft()
        if not bucket:
            _rate_buckets.pop(key, None)


def _enforce_rate_limit(request: Request, scope: str) -> None:
    if not RATE_LIMIT_MAX:
        return
    ip = request.client.host if request.client else "unknown"
    key = f"{scope}:{ip}"
    now = time.time()
    if len(_rate_buckets) > RATE_BUCKET_LIMIT:
        _prune_rate_buckets(now)
    bucket = _rate_buckets[key]
    while bucket and now - bucket[0] > RATE_LIMIT_WINDOW:
        bucket.popleft()
    if len(bucket) >= RATE_LIMIT_MAX:
        raise HTTPException(429, "Too many attempts — try again later")
    bucket.append(now)


# --------------------------------------------------------------------------- #
# Auth / directory endpoints
# --------------------------------------------------------------------------- #
@app.post("/api/register", response_model=TokenResponse)
def register(req: RegisterRequest, request: Request) -> TokenResponse:
    _enforce_rate_limit(request, "register")
    if db.user_exists(req.username):
        raise HTTPException(409, "Username already taken")
    salt = secrets.token_hex(16)
    try:
        db.create_user(
            username=req.username,
            kem_public_key=req.kem_public_key,
            dsa_public_key=req.dsa_public_key,
            fingerprint=req.fingerprint,
            auth_salt=salt,
            auth_hash=_hash_secret(req.auth_secret, salt),
            avatar=req.avatar,
        )
    except sqlite3.IntegrityError:
        # Two registrations for the same name raced past user_exists().
        # The loser gets the same 409 as a sequential duplicate, not a 500.
        raise HTTPException(409, "Username already taken")
    return _issue_token(req.username)


@app.post("/api/login", response_model=TokenResponse)
def login(req: LoginRequest, request: Request) -> TokenResponse:
    _enforce_rate_limit(request, "login")
    user = db.get_user(req.username)
    # Hash against a dummy salt when the user doesn't exist so the response
    # carries the same status/timing either way — this avoids leaking
    # whether a given username is registered (user enumeration).
    salt = user["auth_salt"] if user else _DUMMY_LOGIN_SALT
    got = _hash_secret(req.auth_secret, salt)
    if not user or not secrets.compare_digest(user["auth_hash"], got):
        raise HTTPException(401, "Invalid credentials")
    return _issue_token(req.username)


@app.post("/api/logout")
def logout(authorization: str = Header(default="")) -> dict:
    if authorization.startswith("Bearer "):
        _tokens.pop(authorization[7:], None)
    return {"ok": True}


@app.get("/api/users/{username}", response_model=PublicUser)
def get_public_user(username: str, _me: str = Depends(require_user)) -> PublicUser:
    user = db.get_user(username.lower())
    if not user:
        raise HTTPException(404, "No such user")
    return PublicUser(
        username=user["username"],
        kem_public_key=user["kem_public_key"],
        dsa_public_key=user["dsa_public_key"],
        fingerprint=user["fingerprint"],
        avatar=user.get("avatar"),
    )


@app.get("/api/users")
def search_users(q: str = "", me: str = Depends(require_user)) -> list[dict]:
    results = db.search_users(q.lower().strip()) if q.strip() else []
    return [r for r in results if r["username"] != me]


@app.get("/api/me")
def me(username: str = Depends(require_user)) -> dict:
    user = db.get_user(username)
    if not user:
        # The account was deleted (from another session, or straight out of the
        # database) while this token was still live. 401 tells the client to
        # re-authenticate instead of handing it a 500.
        raise HTTPException(401, "Account no longer exists")
    return {
        "username": username,
        "fingerprint": user["fingerprint"],
        "avatar": user.get("avatar"),
        "contacts": db.list_contacts(username),
        "groups": db.list_groups(username),
    }


@app.put("/api/me/avatar")
def set_avatar(req: AvatarRequest, me: str = Depends(require_user)) -> dict:
    db.set_avatar(me, req.avatar)
    return {"ok": True, "avatar": req.avatar}


@app.delete("/api/me")
async def delete_account(me: str = Depends(require_user)) -> dict:
    """Irreversibly delete the account and everything it owns."""
    contacts = db.list_contacts(me)  # before the envelopes that define them are gone
    groups = await asyncio.to_thread(db.delete_user, me)
    for tok, rec in list(_tokens.items()):
        if rec["username"] == me:
            _tokens.pop(tok, None)
    # Live sockets were keyed only by username and outlived the account: they
    # kept receiving presence, and would have received envelopes addressed to
    # anyone who later registered the same name. Close them the way an
    # expired session is closed.
    await manager.close_user(me, code=4401)
    for peer in contacts:
        await manager._send_to(peer, {"type": "presence", "username": me, "online": False})
    for gid in groups:
        await manager.notify_group_members(
            db.group_member_names(gid),
            {"type": "group", "action": "members", "group_id": gid},
        )
    return {"ok": True}


# --------------------------------------------------------------------------- #
# Messaging (1:1)
# --------------------------------------------------------------------------- #
def _require_file_owner(file_id: str, me: str) -> None:
    """A file message may only point at a blob its sender uploaded. Without
    this, anyone who learned a file_id could post a file message referencing
    it and then pass user_can_access_file() as that message's sender."""
    if not db.file_owned_by(file_id, me):
        raise HTTPException(404, "File not found")


@app.post("/api/messages")
async def send_message(req: SendMessageRequest, me: str = Depends(require_user)) -> dict:
    if not db.user_exists(req.recipient):
        raise HTTPException(404, "Recipient not found")
    env = db.store_envelope(me, req.recipient, "message", req.payload, expires_at=_expiry(req.ttl))
    await manager.deliver(env)
    return env


@app.post("/api/messages/file")
async def send_file_message(
    req: SendFileMessageRequest, me: str = Depends(require_user)
) -> dict:
    if not db.user_exists(req.recipient):
        raise HTTPException(404, "Recipient not found")
    _require_file_owner(req.file_id, me)
    # Ensure the metadata the client displays is stored alongside the envelope.
    # file_id is forced, not defaulted: the client downloads by payload.file_id,
    # and it must name the blob whose ownership was just checked.
    payload = dict(req.payload)
    payload["file_id"] = req.file_id
    payload.setdefault("filename", req.filename)
    payload.setdefault("mime", req.mime)
    payload.setdefault("size", req.size)
    env = db.store_envelope(me, req.recipient, "file", payload,
                            file_id=req.file_id, expires_at=_expiry(req.ttl))
    await manager.deliver(env)
    return env


@app.get("/api/conversations/{peer}")
def conversation(peer: str, since: int = 0, me: str = Depends(require_user)) -> list[dict]:
    return db.get_conversation(me, peer.lower(), since_id=since)


@app.get("/api/inbox")
def inbox(since: int = 0, me: str = Depends(require_user)) -> list[dict]:
    return db.get_inbox(me, since_id=since)


# --------------------------------------------------------------------------- #
# Groups
# --------------------------------------------------------------------------- #
def _require_group_member(group_id: int, me: str) -> dict:
    group = db.get_group(group_id)
    if not group or not db.is_group_member(group_id, me):
        raise HTTPException(404, "Group not found")
    return group


@app.post("/api/groups")
async def create_group(req: CreateGroupRequest, me: str = Depends(require_user)) -> dict:
    members = [m for m in req.members if db.user_exists(m)]
    group = db.create_group(req.name, me, members, req.icon)
    await manager.notify_group_members(
        [m["username"] for m in group["members"]],
        {"type": "group", "action": "created", "group_id": group["id"]},
    )
    return group


@app.get("/api/groups")
def list_groups(me: str = Depends(require_user)) -> list[dict]:
    return db.list_groups(me)


@app.get("/api/groups/{group_id}")
def get_group(group_id: int, me: str = Depends(require_user)) -> dict:
    return _require_group_member(group_id, me)


@app.post("/api/groups/{group_id}/members")
async def add_member(
    group_id: int, req: AddMemberRequest, me: str = Depends(require_user)
) -> dict:
    group = _require_group_member(group_id, me)
    if group["owner"] != me:
        raise HTTPException(403, "Only the group owner can add members")
    if not db.user_exists(req.username):
        raise HTTPException(404, "User not found")
    db.add_group_member(group_id, req.username)
    updated = db.get_group(group_id)
    await manager.notify_group_members(
        [m["username"] for m in updated["members"]],
        {"type": "group", "action": "members", "group_id": group_id},
    )
    return updated


@app.delete("/api/groups/{group_id}/members/{username}")
async def remove_member(
    group_id: int, username: str, me: str = Depends(require_user)
) -> dict:
    group = _require_group_member(group_id, me)
    username = username.lower()
    # The owner may remove anyone; any member may remove themselves (leave).
    if group["owner"] != me and username != me:
        raise HTTPException(403, "Not allowed")
    prior = [m["username"] for m in group["members"]]
    db.remove_group_member(group_id, username)
    # An owner who leaves used to strand the group: nobody could add or remove
    # members again. Hand ownership to the longest-standing remaining member,
    # and drop the group entirely once the last one leaves.
    if username == group["owner"]:
        successor = db.oldest_group_member(group_id)
        if successor:
            db.set_group_owner(group_id, successor)
        else:
            db.delete_group(group_id)
    await manager.notify_group_members(
        prior, {"type": "group", "action": "members", "group_id": group_id},
    )
    return {"ok": True}


@app.post("/api/groups/{group_id}/messages")
async def send_group_message(
    group_id: int, req: GroupMessageRequest, me: str = Depends(require_user)
) -> dict:
    group = _require_group_member(group_id, me)
    env = db.store_group_envelope(group_id, me, "message", req.payload, expires_at=_expiry(req.ttl))
    await manager.deliver_group([m["username"] for m in group["members"]], env)
    return env


@app.post("/api/groups/{group_id}/messages/file")
async def send_group_file(
    group_id: int, req: GroupFileMessageRequest, me: str = Depends(require_user)
) -> dict:
    group = _require_group_member(group_id, me)
    _require_file_owner(req.file_id, me)
    payload = dict(req.payload)
    payload["file_id"] = req.file_id
    payload.setdefault("filename", req.filename)
    payload.setdefault("mime", req.mime)
    payload.setdefault("size", req.size)
    env = db.store_group_envelope(group_id, me, "file", payload,
                                  file_id=req.file_id, expires_at=_expiry(req.ttl))
    await manager.deliver_group([m["username"] for m in group["members"]], env)
    return env


@app.get("/api/groups/{group_id}/messages")
def group_messages(group_id: int, since: int = 0, me: str = Depends(require_user)) -> list[dict]:
    _require_group_member(group_id, me)
    return db.get_group_messages(group_id, since_id=since)


# --------------------------------------------------------------------------- #
# Encrypted files
# --------------------------------------------------------------------------- #
@app.post("/api/files")
async def upload_file(
    file: UploadFile = File(...),
    size: int = Form(...),
    me: str = Depends(require_user),
) -> dict:
    # `size` is the *plaintext* length the client reports, kept as display
    # metadata only. It is attacker-controlled, so bound it rather than storing
    # whatever arrives (a negative or absurd value would render as nonsense).
    if size < 0 or size > MAX_FILE_BYTES:
        raise HTTPException(400, "Invalid file size")
    # Read in bounded chunks so an oversized upload is rejected before it can
    # exhaust server memory/disk, rather than after buffering it in full.
    data = bytearray()
    while True:
        chunk = await file.read(FILE_READ_CHUNK)
        if not chunk:
            break
        data.extend(chunk)
        if len(data) > MAX_FILE_BYTES:
            raise HTTPException(413, f"File exceeds {MAX_FILE_BYTES // (1024*1024)} MB limit")
    file_id = uuid.uuid4().hex
    db.store_file(file_id, me, bytes(data), size)
    return {"file_id": file_id}


@app.get("/api/files/{file_id}")
def download_file(file_id: str, me: str = Depends(require_user)) -> Response:
    # Only the uploader or a sender/recipient of a message (1:1 or group) that
    # references this file may fetch it — file IDs must not act as bearer
    # capabilities for any authenticated user.
    if not db.user_can_access_file(me, file_id):
        raise HTTPException(404, "File not found")
    rec = db.get_file(file_id)
    if not rec:
        raise HTTPException(404, "File not found")
    return Response(
        content=rec["ciphertext"],
        media_type="application/octet-stream",
        headers={"X-Plaintext-Size": str(rec["size"])},
    )


# --------------------------------------------------------------------------- #
# WebSocket real-time delivery
# --------------------------------------------------------------------------- #
class ConnectionManager:
    def __init__(self) -> None:
        self.active: dict[str, set[WebSocket]] = {}

    def connect(self, username: str, ws: WebSocket) -> None:
        """Register an already-accepted, authenticated socket."""
        self.active.setdefault(username, set()).add(ws)

    def disconnect(self, username: str, ws: WebSocket) -> None:
        conns = self.active.get(username)
        if conns:
            conns.discard(ws)
            if not conns:
                self.active.pop(username, None)

    def is_online(self, username: str) -> bool:
        return bool(self.active.get(username))

    async def close_user(self, username: str, code: int = 1000) -> None:
        """Close every socket a user has open."""
        for ws in list(self.active.pop(username, set())):
            with contextlib.suppress(Exception):
                await ws.close(code=code)

    async def _send_to(self, username: str, msg: dict) -> None:
        for ws in list(self.active.get(username, set())):
            try:
                await ws.send_json(msg)
            except Exception:
                self.disconnect(username, ws)

    async def deliver(self, envelope: dict) -> None:
        """Push a 1:1 envelope to the recipient (and echo to the sender's other
        sessions) if they are online. Offline users fetch it later via REST."""
        for target in {envelope["recipient"], envelope["sender"]}:
            await self._send_to(target, {"type": "envelope", "envelope": envelope})

        # A first message is what makes two users contacts, and that moment
        # produces no connect/disconnect transition — so without this the pair
        # would each show the other as offline until one of them reconnects.
        # Both are contacts by definition here, so this respects the same
        # scoping as presence().
        sender, recipient = envelope["sender"], envelope["recipient"]
        if sender != recipient:
            if sender in self.active:
                await self._send_to(recipient, {"type": "presence", "username": sender, "online": True})
            if recipient in self.active:
                await self._send_to(sender, {"type": "presence", "username": recipient, "online": True})

    async def deliver_group(self, members: list[str], envelope: dict) -> None:
        """Push a group envelope to every member currently online."""
        for target in set(members):
            await self._send_to(target, {"type": "group_envelope", "envelope": envelope})

    async def notify_group_members(self, members: list[str], msg: dict) -> None:
        for target in set(members):
            await self._send_to(target, msg)

    async def presence(self, username: str, online: bool) -> None:
        """Notify only this user's contacts — presence shouldn't be
        observable by every authenticated user on the server."""
        msg = {"type": "presence", "username": username, "online": online}
        for peer in db.list_contacts(username):
            await self._send_to(peer, msg)

    async def send_presence_snapshot(self, username: str, ws: WebSocket) -> None:
        """Tell a freshly connected client which of its contacts are already
        online. Presence is otherwise only published on transitions, so without
        this a client that connects (or reloads) shows every contact as offline
        until they happen to reconnect. Scoped to this user's own contacts,
        exactly like presence()."""
        for peer in db.list_contacts(username):
            if peer in self.active:
                try:
                    await ws.send_json({"type": "presence", "username": peer, "online": True})
                except Exception:
                    self.disconnect(username, ws)
                    return


manager = ConnectionManager()


async def _ws_authenticate(ws: WebSocket, query_token: str) -> Optional[str]:
    """Resolve the socket's user.

    Preferred: the client sends {"type": "auth", "token": "..."} as its first
    frame. Keeping the token out of the URL matters behind a reverse proxy —
    Caddy, nginx and uvicorn all write the request line, query string included,
    to their access logs, which would leave live session tokens on disk.

    The ?token= query parameter is still honoured so 1.x/2.0 clients keep
    working against this relay.
    """
    if query_token:
        return _resolve_token(query_token)
    try:
        raw = await asyncio.wait_for(ws.receive_text(), timeout=WS_AUTH_TIMEOUT)
        msg = json.loads(raw)
    except (asyncio.TimeoutError, WebSocketDisconnect, ValueError, KeyError, RuntimeError):
        return None
    if not isinstance(msg, dict) or msg.get("type") != "auth":
        return None
    return _resolve_token(str(msg.get("token") or ""))


@app.websocket("/ws")
async def websocket_endpoint(ws: WebSocket, token: str = "") -> None:
    # Accept before authenticating: closing an un-accepted socket surfaces in
    # the browser as a bare 403/1006, indistinguishable from a proxy that
    # doesn't forward the Upgrade. Accepting first lets the client see 4401
    # and re-login instead of retrying a dead token forever.
    await ws.accept()
    username = await _ws_authenticate(ws, token)
    if not username:
        try:
            await ws.close(code=4401)
        except RuntimeError:
            pass  # client already went away
        return
    manager.connect(username, ws)
    try:
        await ws.send_json({"type": "ready", "username": username})
        await manager.presence(username, True)
        await manager.send_presence_snapshot(username, ws)
        while True:
            frame = await ws.receive()
            if frame["type"] == "websocket.disconnect":
                break
            # Application-level heartbeat. Reverse proxies drop idle upgraded
            # connections (nginx: proxy_read_timeout, 60s by default), and a
            # TCP connection can die silently on a flaky network. The client
            # pings; answering lets it notice a dead socket and reconnect.
            # Binary frames are ignored (receive_text() used to raise KeyError
            # on one, logging a traceback for every stray frame).
            if frame.get("text") == "ping":
                await ws.send_json({"type": "pong"})
    except (WebSocketDisconnect, RuntimeError):
        pass
    finally:
        manager.disconnect(username, ws)
        # Only announce "offline" once the user's *last* socket has gone.
        # Closing one of several tabs used to tell every contact they had left.
        if not manager.is_online(username):
            await manager.presence(username, False)


# --------------------------------------------------------------------------- #
# Health check (for load balancers / hosting platform probes)
# --------------------------------------------------------------------------- #
@app.get("/api/health")
def health() -> dict:
    # max_file_bytes lets the client reject an oversized attachment before it
    # spends time encrypting it, instead of discovering the limit via a 413.
    # `features` lets a client (and the Settings → "Test connection" check)
    # discover what this relay supports without guessing from the version.
    return {
        "status": "ok",
        "version": app.version,
        "max_file_bytes": MAX_FILE_BYTES,
        "time": time.time(),
        "history_page_size": db.HISTORY_PAGE_SIZE,
        "features": _FEATURES,
    }


# What this relay supports. "history-paging" means history endpoints return at
# most history_page_size envelopes per call and clients should page with since=.
_FEATURES = ["ws-auth-message", "ws-pong", "history-paging"] + (["cors-local"] if _cors_allow_local else [])


# --------------------------------------------------------------------------- #
# Static client (served last so /api and /ws take precedence)
#
# A relay without the bundled client is a legitimate configuration — the
# desktop apps and the Chrome extension carry their own copy and only need the
# API. So a missing client directory must not stop the relay from starting;
# mounting StaticFiles on a directory that isn't there raises at import time,
# which used to kill the process with a bare "Directory '...' does not exist"
# that named neither Lattix nor LATTIX_CLIENT_DIR.
# --------------------------------------------------------------------------- #
_INDEX_FILE = os.path.join(CLIENT_DIR, "index.html")
_HAS_CLIENT = os.path.isfile(_INDEX_FILE)

if not _HAS_CLIENT:
    print(
        f"[lattix] No web client at {CLIENT_DIR} — serving the API only.\n"
        f"[lattix] Point LATTIX_CLIENT_DIR at the repository's client/ directory to serve the app.",
        flush=True,
    )


@app.get("/")
def index():
    if not _HAS_CLIENT:
        # Plain text, not JSON: whoever sees this opened it in a browser.
        # (HTTPException would have rendered it as {"detail": ...}.)
        return PlainTextResponse(
            status_code=503,
            content="This Lattix relay is running, but its web client is not installed "
            f"(looked in {CLIENT_DIR}). The API and /ws are available — point a "
            "desktop app or the Chrome extension at this address, or set "
            "LATTIX_CLIENT_DIR to the client/ directory and restart.",
        )
    return FileResponse(_INDEX_FILE)


if _HAS_CLIENT:
    app.mount("/", StaticFiles(directory=CLIENT_DIR, html=True), name="client")
