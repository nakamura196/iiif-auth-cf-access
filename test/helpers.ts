import { env as rawEnv } from "cloudflare:workers";
import { vi } from "vitest";
import worker from "../src/index.ts";
import { b64urlEncode } from "../src/crypto.ts";
import { resetJwksCache } from "../src/access.ts";
import type { CollectionConfig, Env } from "../src/types.ts";

export const BASE = "https://models.example.test";
export const TEAM = "https://test.cloudflareaccess.com";
export const AUD = "aud-railclass";
export const AUD_OTHER = "aud-other";
export const ORIGIN = "https://railclass.ldas.jp";

const base: CollectionConfig = {
  aud: AUD,
  allowedOrigins: [ORIGIN, "http://localhost:4321"],
  label: { en: ["Log in"] },
  heading: { en: ["Please log in"], ja: ["ログインしてください"] },
  note: { en: ["Approved users only."] },
  confirmLabel: { en: ["Log in"] },
  cookieMaxAge: 3600,
};

export const env: Env = {
  ...(rawEnv as unknown as Env),
  ACCESS_TEAM_DOMAIN: TEAM,
  COLLECTIONS: {
    railclass: base,
    other: { ...base, aud: AUD_OTHER, allowedOrigins: ["https://other.example"] },
  },
};
export const railclass = base;

const enc = new TextEncoder();

export interface TestKey {
  kid: string;
  privateKey: CryptoKey;
  jwk: JsonWebKey;
}

export async function makeKey(kid: string): Promise<TestKey> {
  const pair = (await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const jwk = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as JsonWebKey & { kid?: string };
  jwk.kid = kid;
  jwk.alg = "RS256";
  return { kid, privateKey: pair.privateKey, jwk };
}

export const now = () => Math.floor(Date.now() / 1000);

export async function signJwt(
  key: TestKey,
  claims: Record<string, unknown>,
  header: Record<string, unknown> = {},
): Promise<string> {
  const h = b64urlEncode(enc.encode(JSON.stringify({ alg: "RS256", kid: key.kid, typ: "JWT", ...header })));
  const p = b64urlEncode(enc.encode(JSON.stringify(claims)));
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key.privateKey, enc.encode(`${h}.${p}`));
  return `${h}.${p}.${b64urlEncode(new Uint8Array(sig))}`;
}

export function goodClaims(over: Record<string, unknown> = {}) {
  return { iss: TEAM, aud: [AUD], email: "alice@example.org", exp: now() + 600, iat: now(), ...over };
}

/** Serve a fake JWKS for the fake team domain. Returns the spy. */
export function mockJwks(keys: TestKey[]) {
  resetJwksCache();
  const real = globalThis.fetch;
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
    if (url === `${TEAM}/cdn-cgi/access/certs`) {
      return Response.json({ keys: keys.map((k) => k.jwk) });
    }
    return real(input, init);
  });
}

export function call(path: string, init: RequestInit = {}): Promise<Response> {
  return worker.fetch(new Request(`${BASE}${path}`, init), env);
}

export async function login(key: TestKey, collection = "railclass", claims = goodClaims()): Promise<string> {
  const jwt = await signJwt(key, claims);
  const res = await call(`/auth/login/${collection}`, { headers: { "Cf-Access-Jwt-Assertion": jwt } });
  if (res.status !== 200) throw new Error(`login failed: ${res.status}`);
  return (res.headers.get("Set-Cookie") ?? "").split(";")[0]; // "iiifcf_x=value"
}

export interface PostedMessage {
  message: Record<string, unknown>;
  origin: string;
}

/** Extract the postMessage(...) call from a token service page. */
export async function postedMessage(res: Response): Promise<PostedMessage | null> {
  const html = await res.text();
  const start = html.indexOf("window.parent.postMessage(");
  if (start < 0) return null;
  const end = html.indexOf(");</script>", start);
  const args = html.slice(start + "window.parent.postMessage(".length, end);
  const cut = args.lastIndexOf(', "');
  return { message: JSON.parse(args.slice(0, cut)), origin: JSON.parse(args.slice(cut + 2)) };
}

export async function getToken(cookie: string, collection = "railclass"): Promise<string> {
  const res = await call(`/auth/token/${collection}?messageId=m1&origin=${encodeURIComponent(ORIGIN)}`, {
    headers: { Cookie: cookie },
  });
  const posted = await postedMessage(res);
  if (!posted || typeof posted.message.accessToken !== "string") throw new Error("no token");
  return posted.message.accessToken;
}
