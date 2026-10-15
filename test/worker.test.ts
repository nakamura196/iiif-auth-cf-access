import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { signValue } from "../src/crypto.ts";
import { fileUrlExpiry } from "../src/config.ts";
import { serviceBlock } from "../src/iiif.ts";
import {
  AUD, AUD_OTHER, BASE, ORIGIN, TEAM, call, env, getToken, goodClaims, login, makeKey, mockJwks, now,
  postedMessage, railclass, signJwt, type TestKey,
} from "./helpers.ts";

const BYTES = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
let key: TestKey;
let otherKey: TestKey;

beforeAll(async () => {
  key = await makeKey("kid-1");
  otherKey = await makeKey("kid-2");
  await env.FILES.put("railclass/test.glb", BYTES);
  await env.FILES.put("railclass/downloads/test.stl", new Uint8Array([9, 9, 9]));
});

afterEach(() => vi.restoreAllMocks());

describe("login", () => {
  it("sets a session cookie and closes the window", async () => {
    mockJwks([key]);
    const jwt = await signJwt(key, goodClaims());
    const res = await call("/auth/login/railclass", { headers: { "Cf-Access-Jwt-Assertion": jwt } });
    expect(res.status).toBe(200);
    const cookie = res.headers.get("Set-Cookie")!;
    expect(cookie).toMatch(/^iiifcf_railclass=[\w-]+\.[\w-]+; Path=\/; Secure; HttpOnly; SameSite=None; Max-Age=3600$/);
    const html = await res.text();
    expect(html).toContain("window.close()");
    expect(html).toContain("You can close this window");
    expect(html).toContain("閉じて");
  });

  it("accepts a string aud", async () => {
    mockJwks([key]);
    const jwt = await signJwt(key, goodClaims({ aud: AUD }));
    expect((await call("/auth/login/railclass", { headers: { "Cf-Access-Jwt-Assertion": jwt } })).status).toBe(200);
  });

  const bad: [string, () => Promise<string | null>][] = [
    ["wrong aud", () => signJwt(key, goodClaims({ aud: [AUD_OTHER] }))],
    ["wrong iss", () => signJwt(key, goodClaims({ iss: "https://evil.cloudflareaccess.com" }))],
    ["expired", () => signJwt(key, goodClaims({ exp: now() - 3600 }))],
    ["no email", () => signJwt(key, goodClaims({ email: undefined }))],
    ["unknown kid", () => signJwt(otherKey, goodClaims())],
    ["alg none", () => signJwt(key, goodClaims(), { alg: "none" })],
    ["missing header", async () => null],
    ["garbage", async () => "not.a.jwt"],
    [
      "bad signature",
      async () => {
        const jwt = await signJwt(key, goodClaims());
        const [h, , s] = jwt.split(".");
        const forged = btoa(JSON.stringify(goodClaims({ email: "mallory@example.org" })))
          .replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
        return `${h}.${forged}.${s}`;
      },
    ],
  ];
  for (const [name, make] of bad) {
    it(`rejects: ${name}`, async () => {
      mockJwks([key]);
      const jwt = await make();
      const res = await call("/auth/login/railclass", jwt ? { headers: { "Cf-Access-Jwt-Assertion": jwt } } : {});
      expect(res.status).toBe(403);
      expect(res.headers.get("Set-Cookie")).toBeNull();
    });
  }

  it("a JWT for another collection's aud is not accepted", async () => {
    mockJwks([key]);
    const jwt = await signJwt(key, goodClaims({ aud: [AUD_OTHER] }));
    const res = await call("/auth/login/railclass", { headers: { "Cf-Access-Jwt-Assertion": jwt } });
    expect(res.status).toBe(403);
  });
});

describe("token service", () => {
  const url = (q: string, c = "railclass") => `/auth/token/${c}?${q}`;
  const good = `messageId=ae3415&origin=${encodeURIComponent(ORIGIN)}`;

  it("posts AuthAccessToken2 to the exact origin", async () => {
    mockJwks([key]);
    const cookie = await login(key);
    const res = await call(url(good), { headers: { Cookie: cookie } });
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("Content-Security-Policy")).toBe(
      "frame-ancestors https://railclass.ldas.jp http://localhost:4321",
    );
    const p = (await postedMessage(res))!;
    expect(p.origin).toBe(ORIGIN);
    expect(p.message).toMatchObject({
      "@context": "http://iiif.io/api/auth/2/context.json",
      type: "AuthAccessToken2",
      messageId: "ae3415",
      expiresIn: 300,
    });
    expect(typeof p.message.accessToken).toBe("string");
    expect(p.message.accessToken).not.toBe(cookie.split("=")[1]);
  });

  it("posts nothing to a disallowed origin", async () => {
    mockJwks([key]);
    const cookie = await login(key);
    const res = await call(url("messageId=a&origin=https%3A%2F%2Fevil.example"), { headers: { Cookie: cookie } });
    expect(res.status).toBe(200);
    expect(await postedMessage(res)).toBeNull();
  });

  it("missing origin posts nothing; missing messageId is invalidRequest", async () => {
    mockJwks([key]);
    const cookie = await login(key);
    expect(await postedMessage(await call(url("messageId=a"), { headers: { Cookie: cookie } }))).toBeNull();
    const p = (await postedMessage(
      await call(url(`origin=${encodeURIComponent(ORIGIN)}`), { headers: { Cookie: cookie } }),
    ))!;
    expect(p.message).toMatchObject({ type: "AuthAccessTokenError2", profile: "invalidRequest" });
    expect(p.origin).toBe(ORIGIN);
  });

  it("no cookie: missingAspect", async () => {
    const p = (await postedMessage(await call(url(good))))!;
    expect(p.message).toMatchObject({ type: "AuthAccessTokenError2", profile: "missingAspect", messageId: "ae3415" });
  });

  it("expired cookie: expiredAspect", async () => {
    const v = await signValue(env.SIGNING_KEY, { typ: "session", c: "railclass", sub: "a@b", exp: now() - 10 });
    const p = (await postedMessage(await call(url(good), { headers: { Cookie: `iiifcf_railclass=${v}` } })))!;
    expect(p.message.profile).toBe("expiredAspect");
  });

  it("tampered cookie: invalidAspect", async () => {
    mockJwks([key]);
    const cookie = await login(key);
    const tampered = cookie.slice(0, -2) + (cookie.endsWith("AA") ? "BB" : "AA");
    const p = (await postedMessage(await call(url(good), { headers: { Cookie: tampered } })))!;
    expect(p.message.profile).toBe("invalidAspect");
  });

  it("cookie of another collection: invalidAspect", async () => {
    mockJwks([key]);
    const cookie = await login(key, "railclass");
    const value = cookie.split("=")[1];
    const p = (await postedMessage(
      await call(url(`messageId=m&origin=${encodeURIComponent("https://other.example")}`, "other"), {
        headers: { Cookie: `iiifcf_other=${value}` },
      }),
    ))!;
    expect(p.message.profile).toBe("invalidAspect");
  });

  it("a token used as a session cookie is rejected", async () => {
    mockJwks([key]);
    const token = await getToken(await login(key));
    const p = (await postedMessage(await call(url(good), { headers: { Cookie: `iiifcf_railclass=${token}` } })))!;
    expect(p.message.profile).toBe("invalidAspect");
  });

  it("escapes markup in the embedded JSON", async () => {
    const res = await call(url(`messageId=${encodeURIComponent("</script><b>")}&origin=${encodeURIComponent(ORIGIN)}`));
    const html = await res.text();
    expect(html).not.toContain("</script><b>");
    expect(html).toContain("\\u003c/script\\u003e");
  });
});

describe("probe", () => {
  const probe = (token: string | null, path = "test.glb", c = "railclass") =>
    call(`/probe/${c}/${path}`, token ? { headers: { Authorization: `Bearer ${token}` } } : {});

  it("no token: 200 with status 401, heading and note, no location", async () => {
    const res = await probe(null);
    expect(res.status).toBe(200);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      "@context": "http://iiif.io/api/auth/2/context.json",
      type: "AuthProbeResult2",
      status: 401,
      heading: railclass.heading,
      note: railclass.note,
    });
    expect(body.location).toBeUndefined();
  });

  it("garbage and expired tokens: 401", async () => {
    expect(((await (await probe("abc.def")).json()) as { status: number }).status).toBe(401);
    const expired = await signValue(env.SIGNING_KEY, { typ: "token", c: "railclass", sub: "a", exp: now() - 5 });
    expect(((await (await probe(expired)).json()) as { status: number }).status).toBe(401);
  });

  it("valid token: 302 and a location that downloads via /files", async () => {
    mockJwks([key]);
    const token = await getToken(await login(key));
    const res = await probe(token);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: number; location: { id: string; type: string; format: string } };
    expect(body.status).toBe(302);
    expect(body.location.type).toBe("Model");
    expect(body.location.format).toBe("model/gltf-binary");
    expect(body.location.id.startsWith(`${BASE}/files/railclass/test.glb?exp=`)).toBe(true);
    const file = await call(body.location.id.slice(BASE.length));
    expect(file.status).toBe(200);
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(BYTES);
  });

  it("nested path and type by extension", async () => {
    mockJwks([key]);
    const token = await getToken(await login(key));
    const body = (await (await probe(token, "downloads/test.stl")).json()) as {
      status: number; location: { id: string; type: string; format: string };
    };
    expect(body.status).toBe(302);
    expect(body.location).toMatchObject({ type: "Model", format: "model/stl" });
    expect(body.location.id).toContain("/files/railclass/downloads/test.stl?");
  });

  it("token for another collection: 401", async () => {
    mockJwks([key]);
    const cookie = await login(key, "other", goodClaims({ aud: [AUD_OTHER] }));
    const res = await call(`/auth/token/other?messageId=m&origin=${encodeURIComponent("https://other.example")}`, {
      headers: { Cookie: cookie },
    });
    const otherToken = (await postedMessage(res))!.message.accessToken as string;
    expect(typeof otherToken).toBe("string");
    expect(((await (await probe(otherToken)).json()) as { status: number }).status).toBe(401);
  });

  it("a session value used as bearer is rejected", async () => {
    mockJwks([key]);
    const session = (await login(key)).split("=")[1];
    expect(((await (await probe(session)).json()) as { status: number }).status).toBe(401);
  });

  it("valid token, missing object: 404", async () => {
    mockJwks([key]);
    const token = await getToken(await login(key));
    const body = (await (await probe(token, "nope.glb")).json()) as { status: number; location?: unknown };
    expect(body.status).toBe(404);
    expect(body.location).toBeUndefined();
  });

  it("path traversal is not served", async () => {
    mockJwks([key]);
    const token = await getToken(await login(key));
    const body = (await (await probe(token, "..%2Ftest.glb")).json()) as { status: number };
    expect(body.status).toBe(404);
  });

  it("OPTIONS preflight", async () => {
    const res = await call("/probe/railclass/test.glb", { method: "OPTIONS" });
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(res.headers.get("Access-Control-Allow-Headers")).toBe("Authorization");
    expect(res.headers.get("Access-Control-Allow-Methods")).toBe("GET, OPTIONS");
  });
});

describe("files", () => {
  async function signedPath(path = "test.glb", exp = now() + 100): Promise<string> {
    mockJwks([key]);
    const token = await getToken(await login(key));
    const body = (await (await call(`/probe/railclass/${path}`, { headers: { Authorization: `Bearer ${token}` } })).json()) as {
      location: { id: string };
    };
    const u = new URL(body.location.id);
    // Re-sign with the requested expiry (tests hold the signing key).
    const { hmacSign } = await import("../src/crypto.ts");
    const sig = await hmacSign(env.SIGNING_KEY, `files/railclass/${path}|${exp}`);
    return `${u.pathname}?exp=${exp}&sig=${sig}`;
  }

  it("200 with bytes and headers", async () => {
    const res = await call(await signedPath());
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("model/gltf-binary");
    expect(res.headers.get("Content-Length")).toBe("10");
    expect(res.headers.get("Accept-Ranges")).toBe("bytes");
    expect(res.headers.get("ETag")).toBeTruthy();
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(res.headers.get("Access-Control-Expose-Headers")).toContain("Content-Range");
    expect(res.headers.get("Cache-Control")).toMatch(/^private, max-age=(9\d|100)$/);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(BYTES);
  });

  it("Range: 206, open-ended, suffix, and 416", async () => {
    const p = await signedPath();
    const r1 = await call(p, { headers: { Range: "bytes=2-5" } });
    expect(r1.status).toBe(206);
    expect(r1.headers.get("Content-Range")).toBe("bytes 2-5/10");
    expect(r1.headers.get("Content-Length")).toBe("4");
    expect(new Uint8Array(await r1.arrayBuffer())).toEqual(BYTES.slice(2, 6));
    const r2 = await call(p, { headers: { Range: "bytes=7-" } });
    expect(new Uint8Array(await r2.arrayBuffer())).toEqual(BYTES.slice(7));
    const r3 = await call(p, { headers: { Range: "bytes=-3" } });
    expect(r3.headers.get("Content-Range")).toBe("bytes 7-9/10");
    const r4 = await call(p, { headers: { Range: "bytes=50-60" } });
    expect(r4.status).toBe(416);
    expect(r4.headers.get("Content-Range")).toBe("bytes */10");
  });

  it("HEAD: headers without a body", async () => {
    const res = await call(await signedPath(), { method: "HEAD" });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Length")).toBe("10");
    expect(await res.text()).toBe("");
  });

  it("expired URL: 403", async () => {
    expect((await call(await signedPath("test.glb", now() - 5))).status).toBe(403);
  });

  it("tampered signature, changed path, changed exp, missing params: 403", async () => {
    const p = await signedPath();
    const u = new URL(BASE + p);
    const sig = u.searchParams.get("sig")!;
    const flipped = sig.slice(0, -2) + (sig.endsWith("AA") ? "BB" : "AA");
    expect((await call(`${u.pathname}?exp=${u.searchParams.get("exp")}&sig=${flipped}`)).status).toBe(403);
    expect((await call(`/files/railclass/downloads/test.stl?exp=${u.searchParams.get("exp")}&sig=${sig}`)).status).toBe(403);
    expect((await call(`${u.pathname}?exp=${now() + 99999}&sig=${sig}`)).status).toBe(403);
    expect((await call(u.pathname)).status).toBe(403);
  });

  it("valid signature, missing object: 404", async () => {
    const { hmacSign } = await import("../src/crypto.ts");
    const exp = now() + 60;
    const sig = await hmacSign(env.SIGNING_KEY, `files/railclass/ghost.glb|${exp}`);
    expect((await call(`/files/railclass/ghost.glb?exp=${exp}&sig=${sig}`)).status).toBe(404);
  });
});

describe("logout", () => {
  it("clears the cookie and links to the Access logout", async () => {
    const res = await call("/auth/logout/railclass");
    expect(res.status).toBe(200);
    expect(res.headers.get("Set-Cookie")).toBe(
      "iiifcf_railclass=; Path=/; Secure; HttpOnly; SameSite=None; Max-Age=0",
    );
    const html = await res.text();
    expect(html).toContain(`${TEAM}/cdn-cgi/access/logout`);
    expect(html).toContain("ログアウト");
  });
});

describe("routing", () => {
  it("unknown collection and unknown paths: 404", async () => {
    for (const p of [
      "/auth/login/nope", "/auth/token/nope?messageId=a&origin=x", "/auth/logout/nope",
      "/probe/nope/a.glb", "/files/nope/a.glb?exp=1&sig=x", "/", "/auth/login/railclass/extra", "/admin",
    ]) {
      expect((await call(p)).status, p).toBe(404);
    }
  });

  it("prototype keys are not collections", async () => {
    expect((await call("/auth/login/constructor")).status).toBe(404);
    expect((await call("/auth/login/__proto__")).status).toBe(404);
  });
});

describe("serviceBlock", () => {
  it("nests probe > access > token + logout per the spec", () => {
    const b = serviceBlock(BASE + "/", "railclass", "downloads/a b.stl", railclass);
    expect(b.id).toBe(`${BASE}/probe/railclass/downloads/a%20b.stl`);
    expect(b.type).toBe("AuthProbeService2");
    const access = b.service[0];
    expect(access).toMatchObject({
      id: `${BASE}/auth/login/railclass`,
      type: "AuthAccessService2",
      profile: "active",
      label: railclass.label,
      heading: railclass.heading,
      note: railclass.note,
      confirmLabel: railclass.confirmLabel,
    });
    expect(access.service.map((s) => s.type)).toEqual(["AuthAccessTokenService2", "AuthLogoutService2"]);
    expect(access.service[1].id).toBe(`${BASE}/auth/logout/railclass`);
  });
});

describe("file URL expiry", () => {
  it("ends on the hour, with at least 5 minutes left", () => {
    expect(fileUrlExpiry(7200)).toBe(10800); // exactly on the hour: next hour
    expect(fileUrlExpiry(7201)).toBe(10800);
    expect(fileUrlExpiry(10500)).toBe(10800); // 5 minutes left: kept
    expect(fileUrlExpiry(10501)).toBe(14400); // under 5 minutes left: next hour
  });

  it("two probes in the same hour return the same URL", async () => {
    const t = 1_800_000_000; // on an hour boundary
    vi.spyOn(Date, "now").mockReturnValue((t + 600) * 1000);
    mockJwks([key]);
    const token = await getToken(await login(key));
    const get = async () =>
      ((await (await call("/probe/railclass/test.glb", { headers: { Authorization: `Bearer ${token}` } })).json()) as {
        location: { id: string };
      }).location.id;
    const first = await get();
    vi.spyOn(Date, "now").mockReturnValue((t + 840) * 1000); // later, within the 5-minute token
    expect(await get()).toBe(first);
    expect(first).toContain(`exp=${t + 3600}`);
  });
});
