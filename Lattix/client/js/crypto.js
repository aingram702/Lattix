// Lattix — client-side end-to-end cryptography.
//
// Primitives (all run in the browser; nothing secret ever leaves the device):
//   * ML-KEM-768  (FIPS 203)  — post-quantum key encapsulation
//   * ML-DSA-65   (FIPS 204)  — post-quantum digital signatures
//   * HKDF-SHA256 + AES-256-GCM (WebCrypto) — authenticated symmetric encryption
//
// Enveloping scheme
// -----------------
// Each message/file gets a fresh random 256-bit Content Encryption Key (CEK).
// The payload is AES-256-GCM encrypted once under the CEK. The CEK is then
// "wrapped" once per party under a Key-Encryption-Key derived (HKDF) from an
// ML-KEM-768 shared secret. We always wrap for the recipient AND the sender,
// so the sender can read their own sent history across devices.
//
// AES-256 stays safe against quantum adversaries (Grover only halves the
// effective strength to 128 bits), so the whole construction is PQ-secure.

import { ml_kem768, ml_dsa65, randomBytes } from "../vendor/lattix-pqc.js";

const subtle = globalThis.crypto.subtle;
const enc = new TextEncoder();
const dec = new TextDecoder();
const WRAP_INFO = "lattix-wrap-v1";

// ---- encoding helpers ----
export function bytesToB64(bytes) {
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}
export function b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function concat(...arrays) {
  const total = arrays.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const a of arrays) { out.set(a, off); off += a.length; }
  return out;
}
async function sha256Hex(bytes) {
  const d = new Uint8Array(await subtle.digest("SHA-256", bytes));
  return [...d].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ---- identity ----
export async function generateIdentity() {
  const kem = ml_kem768.keygen();
  const dsa = ml_dsa65.keygen(randomBytes(32));
  const fingerprint = await sha256Hex(concat(kem.publicKey, dsa.publicKey));
  return {
    kem: { publicKey: bytesToB64(kem.publicKey), secretKey: bytesToB64(kem.secretKey) },
    dsa: { publicKey: bytesToB64(dsa.publicKey), secretKey: bytesToB64(dsa.secretKey) },
    fingerprint,
    authSecret: bytesToB64(randomBytes(32)),
  };
}
export async function fingerprintOf(kemPubB64, dsaPubB64) {
  return sha256Hex(concat(b64ToBytes(kemPubB64), b64ToBytes(dsaPubB64)));
}
export function prettyFingerprint(hex) {
  return (hex.match(/.{1,4}/g) || []).join(" ").toUpperCase();
}

// ---- symmetric helpers ----
async function importAesKey(rawBytes, usages) {
  return subtle.importKey("raw", rawBytes, { name: "AES-GCM" }, false, usages);
}
async function deriveKek(sharedSecret) {
  const base = await subtle.importKey("raw", sharedSecret, "HKDF", false, ["deriveKey"]);
  return subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: enc.encode(WRAP_INFO) },
    base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]
  );
}
function buildTranscript(prefixBytes, ivContent, ciphertext, keys) {
  let t = concat(prefixBytes, ivContent, ciphertext);
  for (const username of Object.keys(keys).sort()) {
    const k = keys[username];
    t = concat(t, enc.encode(username), b64ToBytes(k.kem_ct), b64ToBytes(k.iv), b64ToBytes(k.wrapped));
  }
  return t;
}
async function wrapCekForParties(cekRaw, recipients) {
  const keys = {};
  for (const r of recipients) {
    const { cipherText: kemCt, sharedSecret } = ml_kem768.encapsulate(b64ToBytes(r.kemPub));
    const kek = await deriveKek(sharedSecret);
    const iv = randomBytes(12);
    const wrapped = new Uint8Array(await subtle.encrypt({ name: "AES-GCM", iv }, kek, cekRaw));
    keys[r.username] = { kem_ct: bytesToB64(kemCt), iv: bytesToB64(iv), wrapped: bytesToB64(wrapped) };
  }
  return keys;
}
async function unwrapCek(keyEntry, myKemSecretB64) {
  const ss = ml_kem768.decapsulate(b64ToBytes(keyEntry.kem_ct), b64ToBytes(myKemSecretB64));
  const kek = await deriveKek(ss);
  const cekRaw = new Uint8Array(
    await subtle.decrypt({ name: "AES-GCM", iv: b64ToBytes(keyEntry.iv) }, kek, b64ToBytes(keyEntry.wrapped))
  );
  return cekRaw;
}

// ---- messages ----
export async function encryptMessage(plaintext, recipients, senderDsaSecretB64) {
  const cekRaw = randomBytes(32);
  const cek = await importAesKey(cekRaw, ["encrypt"]);
  const iv = randomBytes(12);
  const ct = new Uint8Array(await subtle.encrypt({ name: "AES-GCM", iv }, cek, enc.encode(plaintext)));
  const keys = await wrapCekForParties(cekRaw, recipients);
  const transcript = buildTranscript(enc.encode("msg"), iv, ct, keys);
  const signature = ml_dsa65.sign(b64ToBytes(senderDsaSecretB64), transcript);
  return { iv: bytesToB64(iv), ciphertext: bytesToB64(ct), keys, signature: bytesToB64(signature) };
}
export async function decryptMessage(payload, myUsername, myKemSecretB64, senderDsaPubB64) {
  const iv = b64ToBytes(payload.iv);
  const ct = b64ToBytes(payload.ciphertext);
  const transcript = buildTranscript(enc.encode("msg"), iv, ct, payload.keys);
  if (!ml_dsa65.verify(b64ToBytes(senderDsaPubB64), transcript, b64ToBytes(payload.signature))) {
    throw new Error("Signature verification failed — message not authentic");
  }
  const entry = payload.keys[myUsername];
  if (!entry) throw new Error("This message was not addressed to you");
  const cekRaw = await unwrapCek(entry, myKemSecretB64);
  const cek = await importAesKey(cekRaw, ["decrypt"]);
  const pt = await subtle.decrypt({ name: "AES-GCM", iv }, cek, ct);
  return { text: dec.decode(pt), verified: true };
}

// ---- files ----
export async function encryptFile(fileBytes, meta, recipients, senderDsaSecretB64) {
  const cekRaw = randomBytes(32);
  const cek = await importAesKey(cekRaw, ["encrypt"]);
  const iv = randomBytes(12);
  const cipherBytes = new Uint8Array(await subtle.encrypt({ name: "AES-GCM", iv }, cek, fileBytes));
  const keys = await wrapCekForParties(cekRaw, recipients);
  const metaBytes = enc.encode(JSON.stringify({ filename: meta.filename, mime: meta.mime, size: meta.size }));
  const transcript = buildTranscript(metaBytes, iv, new Uint8Array(0), keys);
  const signature = ml_dsa65.sign(b64ToBytes(senderDsaSecretB64), transcript);
  const payload = {
    filename: meta.filename, mime: meta.mime, size: meta.size,
    iv: bytesToB64(iv), keys, signature: bytesToB64(signature),
  };
  return { cipherBytes, payload };
}
export function verifyFilePayload(payload, senderDsaPubB64) {
  const metaBytes = enc.encode(JSON.stringify({ filename: payload.filename, mime: payload.mime, size: payload.size }));
  const transcript = buildTranscript(metaBytes, b64ToBytes(payload.iv), new Uint8Array(0), payload.keys);
  return ml_dsa65.verify(b64ToBytes(senderDsaPubB64), transcript, b64ToBytes(payload.signature));
}
export async function decryptFile(cipherBytes, payload, myUsername, myKemSecretB64, senderDsaPubB64) {
  if (!verifyFilePayload(payload, senderDsaPubB64)) {
    throw new Error("File signature verification failed — not authentic");
  }
  const entry = payload.keys[myUsername];
  if (!entry) throw new Error("This file was not addressed to you");
  const cekRaw = await unwrapCek(entry, myKemSecretB64);
  const cek = await importAesKey(cekRaw, ["decrypt"]);
  const pt = await subtle.decrypt({ name: "AES-GCM", iv: b64ToBytes(payload.iv) }, cek, cipherBytes);
  return new Uint8Array(pt);
}

// ---- local encrypted vault ----
async function vaultKey(password, salt) {
  const base = await subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveKey"]);
  return subtle.deriveKey(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations: 250000 },
    base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]
  );
}
export async function sealVault(identity, password) {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = await vaultKey(password, salt);
  const ct = new Uint8Array(await subtle.encrypt({ name: "AES-GCM", iv }, key, enc.encode(JSON.stringify(identity))));
  return { v: 1, salt: bytesToB64(salt), iv: bytesToB64(iv), ciphertext: bytesToB64(ct) };
}
export async function openVault(vault, password) {
  const key = await vaultKey(password, b64ToBytes(vault.salt));
  try {
    const pt = await subtle.decrypt({ name: "AES-GCM", iv: b64ToBytes(vault.iv) }, key, b64ToBytes(vault.ciphertext));
    return JSON.parse(dec.decode(pt));
  } catch (e) {
    throw new Error("Wrong password or corrupted vault");
  }
}
