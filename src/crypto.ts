import type { SignedPayload, SignedType } from "./types.ts";

const enc = new TextEncoder();
const dec = new TextDecoder();

export function b64urlEncode(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function b64urlDecode(text: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) return null;
  const pad = text.replace(/-/g, "+").replace(/_/g, "/");
  try {
    const bin = atob(pad + "=".repeat((4 - (pad.length % 4)) % 4));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

const keyCache = new Map<string, Promise<CryptoKey>>();

function hmacKey(secret: string): Promise<CryptoKey> {
  let k = keyCache.get(secret);
  if (!k) {
    k = crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
      "sign",
      "verify",
    ]);
    keyCache.set(secret, k);
  }
  return k;
}

export async function hmacSign(secret: string, data: string): Promise<string> {
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(secret), enc.encode(data));
  return b64urlEncode(new Uint8Array(sig));
}

/** Constant-time check (crypto.subtle.verify compares in constant time). */
export async function hmacVerify(secret: string, data: string, sig: string): Promise<boolean> {
  const raw = b64urlDecode(sig);
  if (!raw) return false;
  return crypto.subtle.verify("HMAC", await hmacKey(secret), raw, enc.encode(data));
}

export async function signValue(secret: string, payload: SignedPayload): Promise<string> {
  const body = b64urlEncode(enc.encode(JSON.stringify(payload)));
  return `${body}.${await hmacSign(secret, body)}`;
}

export type Verdict =
  | { ok: true; payload: SignedPayload }
  | { ok: false; reason: "invalid" | "expired" };

/**
 * Verify a signed value. It is rejected as "invalid" unless the signature is
 * valid AND typ and collection match what the caller expects, so a token can
 * never be used as a session (or the reverse) and never across collections.
 */
export async function verifyValue(
  secret: string,
  value: string,
  typ: SignedType,
  collection: string,
  now: number,
): Promise<Verdict> {
  const parts = value.split(".");
  if (parts.length !== 2) return { ok: false, reason: "invalid" };
  const [body, sig] = parts;
  if (!(await hmacVerify(secret, body, sig))) return { ok: false, reason: "invalid" };
  const raw = b64urlDecode(body);
  if (!raw) return { ok: false, reason: "invalid" };
  let p: unknown;
  try {
    p = JSON.parse(dec.decode(raw));
  } catch {
    return { ok: false, reason: "invalid" };
  }
  const o = p as Partial<SignedPayload> | null;
  if (
    !o ||
    typeof o !== "object" ||
    o.typ !== typ ||
    o.c !== collection ||
    typeof o.sub !== "string" ||
    typeof o.exp !== "number"
  ) {
    return { ok: false, reason: "invalid" };
  }
  if (o.exp <= now) return { ok: false, reason: "expired" };
  return { ok: true, payload: o as SignedPayload };
}
