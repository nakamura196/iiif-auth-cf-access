import { b64urlDecode } from "./crypto.ts";

const dec = new TextDecoder();
const enc = new TextEncoder();

const JWKS_TTL_MS = 10 * 60 * 1000;
const REFETCH_MIN_MS = 30 * 1000;
const CLOCK_SKEW_S = 60;

interface JwksEntry {
  keys: Map<string, JsonWebKey>;
  fetchedAt: number;
}
const jwksCache = new Map<string, JwksEntry>();

/** For tests. */
export function resetJwksCache(): void {
  jwksCache.clear();
}

export function normalizeTeamDomain(d: string): string {
  return d.replace(/\/+$/, "");
}

async function loadJwks(team: string): Promise<JwksEntry> {
  const res = await fetch(`${team}/cdn-cgi/access/certs`);
  if (!res.ok) throw new Error(`JWKS fetch failed: ${res.status}`);
  const body = (await res.json()) as { keys?: (JsonWebKey & { kid?: string })[] };
  const keys = new Map<string, JsonWebKey>();
  for (const k of body.keys ?? []) if (k.kid && k.kty === "RSA") keys.set(k.kid, k);
  const entry = { keys, fetchedAt: Date.now() };
  jwksCache.set(team, entry);
  return entry;
}

async function findKey(team: string, kid: string): Promise<JsonWebKey | null> {
  let entry = jwksCache.get(team);
  const age = entry ? Date.now() - entry.fetchedAt : Infinity;
  if (!entry || age > JWKS_TTL_MS) entry = await loadJwks(team);
  let key = entry.keys.get(kid);
  // Unknown kid: keys may have rotated. Refetch, but not more than every 30 s.
  if (!key && Date.now() - entry.fetchedAt > REFETCH_MIN_MS) {
    entry = await loadJwks(team);
    key = entry.keys.get(kid);
  }
  return key ?? null;
}

function parseJson(bytes: Uint8Array | null): Record<string, unknown> | null {
  if (!bytes) return null;
  try {
    const v = JSON.parse(dec.decode(bytes));
    return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Verify a Cloudflare Access JWT (RS256). Returns the email, or null on any
 * failure. JWKS fetch errors propagate (they are not the user's fault).
 */
export async function verifyAccessJwt(
  jwt: string | null,
  teamDomain: string,
  aud: string,
  nowSeconds: number,
): Promise<string | null> {
  if (!jwt) return null;
  const parts = jwt.split(".");
  if (parts.length !== 3) return null;
  const header = parseJson(b64urlDecode(parts[0]));
  const claims = parseJson(b64urlDecode(parts[1]));
  const sig = b64urlDecode(parts[2]);
  if (!header || !claims || !sig) return null;
  if (header.alg !== "RS256" || typeof header.kid !== "string") return null;

  const team = normalizeTeamDomain(teamDomain);
  const jwk = await findKey(team, header.kid);
  if (!jwk) return null;
  const key = await crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const ok = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    sig,
    enc.encode(`${parts[0]}.${parts[1]}`),
  );
  if (!ok) return null;

  if (typeof claims.iss !== "string" || normalizeTeamDomain(claims.iss) !== team) return null;
  const auds = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud || !auds.includes(aud)) return null;
  if (typeof claims.exp !== "number" || claims.exp + CLOCK_SKEW_S <= nowSeconds) return null;
  if (typeof claims.nbf === "number" && claims.nbf - CLOCK_SKEW_S > nowSeconds) return null;
  if (typeof claims.email !== "string" || claims.email === "") return null;
  return claims.email;
}
