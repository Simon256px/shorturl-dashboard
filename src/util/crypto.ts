/**
 * Slug generation, password hashing and privacy-preserving visitor hashing.
 *
 * Everything random here comes from node:crypto's CSPRNG. There is no
 * Math.random() in this file on purpose — a guessable slug is a data leak.
 */

import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

/**
 * Slug alphabet: base58-ish. No 0/O/I/l — slugs get read aloud and typed by
 * hand, and ambiguous glyphs turn that into a support ticket.
 */
const SLUG_ALPHABET = "123456789abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ";

export const SLUG_MIN_LENGTH = 3;
export const SLUG_MAX_LENGTH = 64;

/**
 * Rejection sampling, so every character is uniformly distributed:
 * `byte % alphabet.length` would quietly bias the first few characters.
 */
export function generateSlug(length = 7): string {
  const n = SLUG_ALPHABET.length;
  const limit = 256 - (256 % n); // largest multiple of n representable in a byte
  let out = "";
  while (out.length < length) {
    for (const b of randomBytes(length * 2)) {
      if (b >= limit) continue; // would bias the distribution — resample
      out += SLUG_ALPHABET[b % n];
      if (out.length === length) break;
    }
  }
  return out;
}

/** URL-safe random token, used for sessions and API keys. */
export function generateToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

// --- Password hashing -------------------------------------------------------

const SCRYPT_N = 1 << 15; // 32768 — tens of ms per hash
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 32;
// scrypt needs ~128 * N * r bytes; Node's default 32 MiB cap is too low for N=2^15.
const maxmemFor = (n: number, r: number) => 256 * n * r + 1024 * 1024;

/** Returns `scrypt$N$r$p$saltB64$hashB64`. */
export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password.normalize("NFKC"), salt, SCRYPT_KEYLEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: maxmemFor(SCRYPT_N, SCRYPT_R),
  });
  return [
    "scrypt",
    SCRYPT_N,
    SCRYPT_R,
    SCRYPT_P,
    salt.toString("base64"),
    hash.toString("base64"),
  ].join("$");
}

/** Constant-time verification. Returns false on any malformed input. */
export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;

  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) return false;
  // Refuse absurd work factors: a tampered hash string must not become a DoS.
  if (N < 2 || N > 1 << 20 || r < 1 || r > 32 || p < 1 || p > 16) return false;

  let salt: Uint8Array;
  let expected: Uint8Array;
  try {
    salt = decodeBase64(parts[4]!);
    expected = decodeBase64(parts[5]!);
  } catch {
    return false;
  }
  if (expected.length === 0 || salt.length === 0) return false;

  try {
    const actual = scryptSync(password.normalize("NFKC"), salt, expected.length, {
      N,
      r,
      p,
      maxmem: maxmemFor(N, r),
    });
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

function decodeBase64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * Constant-time comparison of two secrets. Compares digests rather than raw
 * bytes so differing lengths don't need a separate (leaky) branch.
 */
export function safeEqualStrings(a: string, b: string): boolean {
  const da = createHash("sha256").update(a, "utf8").digest();
  const db = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(da, db);
}

// --- Visitor fingerprinting (GDPR-friendly) ---------------------------------

/**
 * A visitor id is `sha256(dailySalt || ip || userAgent)` truncated to 16 hex
 * chars. The raw IP never reaches disk, and because the salt rotates (and old
 * salts are deleted) every UTC day, yesterday's ids cannot be correlated with
 * today's — the stored data stops being personal data once the salt is gone.
 */
export function visitorId(dailySalt: string, ip: string, userAgent: string): string {
  return sha256Hex(`${dailySalt}|${ip}|${userAgent}`).slice(0, 16);
}
