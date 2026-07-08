"""
Lattix relay server.

Architecture / trust model
--------------------------
Lattix is end-to-end encrypted. The server is a *dumb, zero-knowledge relay*:

  * It stores each user's PUBLIC keys (ML-KEM-768 + ML-DSA-65) in a directory.
  * It stores and forwards opaque encrypted envelopes.
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

import base64
import hashlib
import os
import secrets
import time
import uuid
from typing import Optional

from fastapi import (
    FastAPI, HTTPException, Depends, Header, UploadFile, File, Form, WebSocket,
    WebSocketDisconnect,
)
from fastapi.responses import Response, FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from . import database as db
from .models import (
    RegisterRequest, LoginRequest, PublicUser, SendMessageRequest,
    SendFileMessageRequest, TokenResponse,
)

# --------------------------------------------------------------------------- #
# Config
# --------------------------------------------------------------------------- #
CLIENT_DIR = os.path.join(os.path.dirname(os.path.dirname(__file__)), "client")
MAX_FILE_BYTES = int(os.environ.get("LATTIX_MAX_FILE_MB", "50")) * 1024 * 1024
TOKEN_TTL = 60 * 60 * 12  # 12 hours
PBKDF2_ITERS = 200_000

app = FastAPI(title="Lattix", version="1.0.0", docs_url="/api/docs")


@app.on_event("startup")
def _startup() -> None:
    db.init_db()


# --------------------------------------------------------------------------- #
# Token store (in-memory; fine for a single-process deployment)
# --------------------------------------------------------------------------- #
_tokens: dict[str, dict] = {}  # token -> {username, expires_at}


def _issue_token(username: str) -> TokenResponse:
    token = secrets.token_urlsafe(32)
    expires_at = time.time() + TOKEN_TTL
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
# Auth / directory endpoints
# --------------------------------------------------------------------------- #
@app.post("/api/register", response_model=TokenResponse)
def register(req: RegisterRequest) -> TokenResponse:
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
    )
    return _issue_token(req.username)


@app.post("/api/login", response_model=TokenResponse)
def login(req: LoginRequest) -> TokenResponse:
    user = db.get_user(req.username)
    if not user:
        raise HTTPException(404, "No such user")
    expected = user["auth_hash"]
    got = _hash_secret(req.auth_secret, user["auth_salt"])
    if not secrets.compare_digest(expected, got):
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
        "contacts": db.list_contacts(username),
    }


# --------------------------------------------------------------------------- #
# Messaging
# --------------------------------------------------------------------------- #
@app.post("/api/messages")
async def send_message(req: SendMessageRequest, me: str = Depends(require_user)) -> dict:
    if not db.user_exists(req.recipient):
        raise HTTPException(404, "Recipient not found")
    env = db.store_envelope(me, req.recipient, "message", req.payload)
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
    env = db.store_envelope(me, req.recipient, "file", payload)
    await manager.deliver(env)
    return env


@app.get("/api/conversations/{peer}")
def conversation(peer: str, since: int = 0, me: str = Depends(require_user)) -> list[dict]:
    return db.get_conversation(me, peer.lower(), since_id=since)


@app.get("/api/inbox")
def inbox(since: int = 0, me: str = Depends(require_user)) -> list[dict]:
    return db.get_inbox(me, since_id=since)


# --------------------------------------------------------------------------- #
# Encrypted files
# --------------------------------------------------------------------------- #
@app.post("/api/files")
async def upload_file(
    file: UploadFile = File(...),
    size: int = Form(...),
    me: str = Depends(require_user),
) -> dict:
    data = await file.read()
    if len(data) > MAX_FILE_BYTES:
        raise HTTPException(413, f"File exceeds {MAX_FILE_BYTES // (1024*1024)} MB limit")
    file_id = uuid.uuid4().hex
    db.store_file(file_id, me, data, size)
    return {"file_id": file_id}


@app.get("/api/files/{file_id}")
def download_file(file_id: str, _me: str = Depends(require_user)) -> Response:
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

    async def deliver(self, envelope: dict) -> None:
        """Push an envelope to the recipient (and echo to the sender's other
        sessions) if they are online. Offline users fetch it later via REST."""
        for target in {envelope["recipient"], envelope["sender"]}:
            for ws in list(self.active.get(target, set())):
                try:
                    await ws.send_json({"type": "envelope", "envelope": envelope})
                except Exception:
                    self.disconnect(target, ws)

    async def presence(self, username: str, online: bool) -> None:
        msg = {"type": "presence", "username": username, "online": online}
        for conns in self.active.values():
            for ws in list(conns):
                try:
                    await ws.send_json(msg)
                except Exception:
                    pass


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
