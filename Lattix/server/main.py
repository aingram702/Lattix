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
import hashlib
import os
import secrets
import time
import uuid
from collections import defaultdict, deque
from typing import Optional

from fastapi import (
    FastAPI, HTTPException, Depends, Header, Request, UploadFile, File, Form,
    WebSocket, WebSocketDisconnect,
)
from fastapi.responses import Response, FileResponse
from fastapi.staticfiles import StaticFiles

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
MAX_FILE_BYTES = int(os.environ.get("LATTIX_MAX_FILE_MB", "50")) * 1024 * 1024
FILE_READ_CHUNK = 1024 * 1024
TOKEN_TTL = 60 * 60 * 12  # 12 hours
PBKDF2_ITERS = 200_000
# A dummy salt used to run the password hash on a non-existent user too, so
# login timing doesn't reveal whether a username exists.
_DUMMY_LOGIN_SALT = secrets.token_hex(16)

app = FastAPI(title="Lattix", version="1.1.0", docs_url="/api/docs")


@app.on_event("startup")
async def _startup() -> None:
    db.init_db()
    asyncio.create_task(_sweep_loop())


async def _sweep_loop() -> None:
    """Periodically purge disappearing messages whose deadline has passed."""
    while True:
        try:
            db.delete_expired()
        except Exception:
            pass
        await asyncio.sleep(60)


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
RATE_LIMIT_WINDOW = 300  # seconds
RATE_LIMIT_MAX = 10  # attempts per window per (scope, ip)

_rate_buckets: dict[str, deque] = defaultdict(deque)


def _enforce_rate_limit(request: Request, scope: str) -> None:
    ip = request.client.host if request.client else "unknown"
    key = f"{scope}:{ip}"
    now = time.time()
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
    db.create_user(
        username=req.username,
        kem_public_key=req.kem_public_key,
        dsa_public_key=req.dsa_public_key,
        fingerprint=req.fingerprint,
        auth_salt=salt,
        auth_hash=_hash_secret(req.auth_secret, salt),
        avatar=req.avatar,
    )
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
def delete_account(me: str = Depends(require_user)) -> dict:
    """Irreversibly delete the account and everything it owns."""
    db.delete_user(me)
    for tok, rec in list(_tokens.items()):
        if rec["username"] == me:
            _tokens.pop(tok, None)
    return {"ok": True}


# --------------------------------------------------------------------------- #
# Messaging (1:1)
# --------------------------------------------------------------------------- #
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
    # Ensure the metadata the client displays is stored alongside the envelope.
    payload = dict(req.payload)
    payload.setdefault("file_id", req.file_id)
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
    payload = dict(req.payload)
    payload.setdefault("file_id", req.file_id)
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

    async def connect(self, username: str, ws: WebSocket) -> None:
        await ws.accept()
        self.active.setdefault(username, set()).add(ws)

    def disconnect(self, username: str, ws: WebSocket) -> None:
        conns = self.active.get(username)
        if conns:
            conns.discard(ws)
            if not conns:
                self.active.pop(username, None)

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


manager = ConnectionManager()


@app.websocket("/ws")
async def websocket_endpoint(ws: WebSocket, token: str = "") -> None:
    username = _resolve_token(token)
    if not username:
        await ws.close(code=4401)
        return
    await manager.connect(username, ws)
    await manager.presence(username, True)
    try:
        # Keep the socket alive; clients may send pings.
        while True:
            await ws.receive_text()
    except WebSocketDisconnect:
        pass
    finally:
        manager.disconnect(username, ws)
        await manager.presence(username, False)


# --------------------------------------------------------------------------- #
# Static client (served last so /api and /ws take precedence)
# --------------------------------------------------------------------------- #
@app.get("/")
def index() -> FileResponse:
    return FileResponse(os.path.join(CLIENT_DIR, "index.html"))


app.mount("/", StaticFiles(directory=CLIENT_DIR, html=True), name="client")
