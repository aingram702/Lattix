"""Pydantic models for the Lattix relay API.

The server treats message/file payloads as OPAQUE blobs — it never inspects or
depends on the internal crypto structure. This keeps the relay agnostic to the
client's encryption scheme.
"""

from __future__ import annotations

import base64
import binascii
import json
from typing import Any, Optional
from pydantic import BaseModel, Field, field_validator

USERNAME_RE = r"^[a-zA-Z0-9_.-]{3,32}$"
# The public directory is writable by anyone who can register, so the key
# material it accepts is bounded and shape-checked. The real sizes are
# ML-KEM-768: 1184 bytes (~1580 base64 chars) and ML-DSA-65: 1952 bytes
# (~2604); the caps below leave room without letting the table be stuffed.
MAX_KEM_KEY_CHARS = 4096
MAX_DSA_KEY_CHARS = 8192
FINGERPRINT_RE = r"^[0-9a-f]{64}$"   # hex SHA-256 of the two public keys
MAX_AUTH_SECRET_CHARS = 512
# Group icons are a single emoji; a few code points allow for ZWJ sequences.
MAX_GROUP_ICON_CHARS = 8

# Envelope payloads carry small crypto material (ciphertext, wrapped keys,
# signatures) — actual file content goes through /api/files instead. Cap the
# size so an authenticated user can't exhaust storage/memory with oversized
# JSON bodies on the message endpoints (which have no upload size limit).
MAX_PAYLOAD_BYTES = 2 * 1024 * 1024
# Profile images are downscaled client-side; cap the stored data URL so the
# directory can't be stuffed with large blobs.
MAX_AVATAR_CHARS = 400 * 1024
# Bound the disappearing-message timer (max 4 weeks).
MAX_TTL_SECONDS = 60 * 60 * 24 * 28


def _check_payload_size(payload: dict[str, Any]) -> dict[str, Any]:
    if len(json.dumps(payload)) > MAX_PAYLOAD_BYTES:
        raise ValueError(f"payload exceeds {MAX_PAYLOAD_BYTES} bytes")
    return payload


def _check_ttl(v: Optional[int]) -> Optional[int]:
    if v is None:
        return None
    if v <= 0 or v > MAX_TTL_SECONDS:
        raise ValueError("ttl out of range")
    return v


def _check_base64(v: str) -> str:
    try:
        base64.b64decode(v, validate=True)
    except (binascii.Error, ValueError):
        raise ValueError("expected base64-encoded key material")
    return v


def _check_avatar(v: Optional[str]) -> Optional[str]:
    if v is None:
        return None
    if len(v) > MAX_AVATAR_CHARS:
        raise ValueError("avatar too large")
    if not v.startswith("data:image/"):
        raise ValueError("avatar must be an image data URL")
    return v


class RegisterRequest(BaseModel):
    username: str = Field(..., pattern=USERNAME_RE)
    kem_public_key: str = Field(..., min_length=1, max_length=MAX_KEM_KEY_CHARS)
    dsa_public_key: str = Field(..., min_length=1, max_length=MAX_DSA_KEY_CHARS)
    fingerprint: str = Field(..., pattern=FINGERPRINT_RE)
    auth_secret: str = Field(..., min_length=1, max_length=MAX_AUTH_SECRET_CHARS)
    avatar: Optional[str] = None

    @field_validator("username")
    @classmethod
    def lower(cls, v: str) -> str:
        return v.lower()

    @field_validator("kem_public_key", "dsa_public_key")
    @classmethod
    def base64_key(cls, v: str) -> str:
        return _check_base64(v)

    @field_validator("avatar")
    @classmethod
    def avatar_ok(cls, v: Optional[str]) -> Optional[str]:
        return _check_avatar(v)


class LoginRequest(BaseModel):
    username: str = Field(..., pattern=USERNAME_RE)
    auth_secret: str = Field(..., min_length=1, max_length=MAX_AUTH_SECRET_CHARS)

    @field_validator("username")
    @classmethod
    def lower(cls, v: str) -> str:
        return v.lower()


class PublicUser(BaseModel):
    username: str
    kem_public_key: str
    dsa_public_key: str
    fingerprint: str
    avatar: Optional[str] = None


class AvatarRequest(BaseModel):
    avatar: Optional[str] = None

    @field_validator("avatar")
    @classmethod
    def avatar_ok(cls, v: Optional[str]) -> Optional[str]:
        return _check_avatar(v)


class SendMessageRequest(BaseModel):
    recipient: str = Field(..., pattern=USERNAME_RE)
    payload: dict[str, Any]  # opaque encrypted envelope
    ttl: Optional[int] = None  # disappearing-message seconds

    @field_validator("recipient")
    @classmethod
    def lower(cls, v: str) -> str:
        return v.lower()

    @field_validator("payload")
    @classmethod
    def payload_size(cls, v: dict[str, Any]) -> dict[str, Any]:
        return _check_payload_size(v)

    @field_validator("ttl")
    @classmethod
    def ttl_ok(cls, v: Optional[int]) -> Optional[int]:
        return _check_ttl(v)


class SendFileMessageRequest(BaseModel):
    recipient: str = Field(..., pattern=USERNAME_RE)
    file_id: str
    filename: str
    mime: str
    size: int
    payload: dict[str, Any]  # opaque encrypted envelope (includes wrapped keys)
    ttl: Optional[int] = None

    @field_validator("recipient")
    @classmethod
    def lower(cls, v: str) -> str:
        return v.lower()

    @field_validator("payload")
    @classmethod
    def payload_size(cls, v: dict[str, Any]) -> dict[str, Any]:
        return _check_payload_size(v)

    @field_validator("ttl")
    @classmethod
    def ttl_ok(cls, v: Optional[int]) -> Optional[int]:
        return _check_ttl(v)


class CreateGroupRequest(BaseModel):
    name: str = Field(..., min_length=1, max_length=64)
    # Every group message is wrapped once per member, so a huge roster is a
    # cost the sender pays on every send. Cap it at something a relay of this
    # shape can serve comfortably.
    members: list[str] = Field(default_factory=list, max_length=256)
    icon: Optional[str] = Field(default=None, max_length=MAX_GROUP_ICON_CHARS)  # emoji only

    @field_validator("members")
    @classmethod
    def lower_members(cls, v: list[str]) -> list[str]:
        # Normalise and de-duplicate while preserving the order given.
        seen: set[str] = set()
        out: list[str] = []
        for m in v:
            u = m.lower()
            if u not in seen:
                seen.add(u)
                out.append(u)
        return out


class AddMemberRequest(BaseModel):
    username: str = Field(..., pattern=USERNAME_RE)

    @field_validator("username")
    @classmethod
    def lower(cls, v: str) -> str:
        return v.lower()


class GroupMessageRequest(BaseModel):
    payload: dict[str, Any]
    ttl: Optional[int] = None

    @field_validator("payload")
    @classmethod
    def payload_size(cls, v: dict[str, Any]) -> dict[str, Any]:
        return _check_payload_size(v)

    @field_validator("ttl")
    @classmethod
    def ttl_ok(cls, v: Optional[int]) -> Optional[int]:
        return _check_ttl(v)


class GroupFileMessageRequest(BaseModel):
    file_id: str
    filename: str
    mime: str
    size: int
    payload: dict[str, Any]
    ttl: Optional[int] = None

    @field_validator("payload")
    @classmethod
    def payload_size(cls, v: dict[str, Any]) -> dict[str, Any]:
        return _check_payload_size(v)

    @field_validator("ttl")
    @classmethod
    def ttl_ok(cls, v: Optional[int]) -> Optional[int]:
        return _check_ttl(v)


class TokenResponse(BaseModel):
    token: str
    username: str
    expires_at: float
