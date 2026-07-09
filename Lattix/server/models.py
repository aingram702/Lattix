"""Pydantic models for the Lattix relay API.

The server treats message/file payloads as OPAQUE blobs — it never inspects or
depends on the internal crypto structure. This keeps the relay agnostic to the
client's encryption scheme.
"""

from __future__ import annotations

import json
from typing import Any
from pydantic import BaseModel, Field, field_validator

USERNAME_RE = r"^[a-zA-Z0-9_.-]{3,32}$"

# Envelope payloads carry small crypto material (ciphertext, wrapped keys,
# signatures) — actual file content goes through /api/files instead. Cap the
# size so an authenticated user can't exhaust storage/memory with oversized
# JSON bodies on the message endpoints (which have no upload size limit).
MAX_PAYLOAD_BYTES = 2 * 1024 * 1024


def _check_payload_size(payload: dict[str, Any]) -> dict[str, Any]:
    if len(json.dumps(payload)) > MAX_PAYLOAD_BYTES:
        raise ValueError(f"payload exceeds {MAX_PAYLOAD_BYTES} bytes")
    return payload


class RegisterRequest(BaseModel):
    username: str = Field(..., pattern=USERNAME_RE)
    kem_public_key: str
    dsa_public_key: str
    fingerprint: str
    auth_secret: str

    @field_validator("username")
    @classmethod
    def lower(cls, v: str) -> str:
        return v.lower()


class LoginRequest(BaseModel):
    username: str = Field(..., pattern=USERNAME_RE)
    auth_secret: str

    @field_validator("username")
    @classmethod
    def lower(cls, v: str) -> str:
        return v.lower()


class PublicUser(BaseModel):
    username: str
    kem_public_key: str
    dsa_public_key: str
    fingerprint: str


class SendMessageRequest(BaseModel):
    recipient: str = Field(..., pattern=USERNAME_RE)
    payload: dict[str, Any]  # opaque encrypted envelope

    @field_validator("recipient")
    @classmethod
    def lower(cls, v: str) -> str:
        return v.lower()

    @field_validator("payload")
    @classmethod
    def payload_size(cls, v: dict[str, Any]) -> dict[str, Any]:
        return _check_payload_size(v)


class SendFileMessageRequest(BaseModel):
    recipient: str = Field(..., pattern=USERNAME_RE)
    file_id: str
    filename: str
    mime: str
    size: int
    payload: dict[str, Any]  # opaque encrypted envelope (includes wrapped keys)

    @field_validator("recipient")
    @classmethod
    def lower(cls, v: str) -> str:
        return v.lower()

    @field_validator("payload")
    @classmethod
    def payload_size(cls, v: dict[str, Any]) -> dict[str, Any]:
        return _check_payload_size(v)


class TokenResponse(BaseModel):
    token: str
    username: str
    expires_at: float
