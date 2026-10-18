import { beforeAll, describe, expect, it } from "vitest";
import { BASE, call, env, getToken, postedMessage } from "./helpers.ts";
import { serviceBlock } from "../src/iiif.ts";
import type { CollectionConfig } from "../src/types.ts";

const BYTES = new Uint8Array([0, 1, 2, 3]);

function post(collection: string, username: string, password: string): Promise<Response> {
  return call(`/auth/login/${collection}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ username, password }).toString(),
  });
}

beforeAll(async () => {
  await env.FILES!.put("formlogin/m.glb", BYTES);
  await env.FILES!.put("extlogin/m.glb", BYTES);
});

describe("login mode (form in a popup)", () => {
  it("GET shows the form and the public demo credentials", async () => {
    const res = await call("/auth/login/formlogin");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('<form method="post" action="/auth/login/formlogin">');
    expect(html).toContain("<code>demo</code>");
    expect(html).toContain("<code>pw-for-test</code>");
    expect(res.headers.get("Set-Cookie")).toBeNull();
  });

  it("wrong password: 401, the form again, no cookie", async () => {
    const res = await post("formlogin", "demo", "nope");
    expect(res.status).toBe(401);
    expect(res.headers.get("Set-Cookie")).toBeNull();
    expect(await res.text()).toContain("<form");
  });

  it("wrong user and a body that is not a form are refused too", async () => {
    expect((await post("formlogin", "someone", "pw-for-test")).status).toBe(401);
    const res = await call("/auth/login/formlogin", { method: "POST", headers: { "Content-Type": "text/plain" }, body: "x" });
    expect(res.status).toBe(401);
  });

  it("right password: cookie, window closes, token then probe 200", async () => {
    const res = await post("formlogin", "demo", "pw-for-test");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("window.close()");
    const cookie = (res.headers.get("Set-Cookie") ?? "").split(";")[0];
    expect(cookie).toMatch(/^iiifcf_formlogin=/);
    const token = await getToken(cookie, "formlogin");
    const probe = await call("/probe/formlogin/m.glb", { headers: { Authorization: `Bearer ${token}` } });
    expect(((await probe.json()) as { status: number }).status).toBe(302);
  });

  it("no token: the probe answers 401", async () => {
    const probe = await call("/probe/formlogin/m.glb");
    expect(((await probe.json()) as { status: number }).status).toBe(401);
  });

  it("service block is active with a login id", () => {
    const block = serviceBlock(BASE, "formlogin", "m.glb", (env.COLLECTIONS as Record<string, CollectionConfig>).formlogin);
    expect(block.service[0]).toMatchObject({ profile: "active", id: `${BASE}/auth/login/formlogin` });
  });

  it("logout clears the cookie with a plain page", async () => {
    const res = await call("/auth/logout/formlogin");
    expect(res.headers.get("Set-Cookie")).toContain("Max-Age=0");
    const html = await res.text();
    expect(html).toContain("ログアウトしました");
    expect(html).not.toContain("cdn-cgi/access/logout");
  });

  it("fails closed when the password is not configured", async () => {
    expect((await call("/auth/login/nopass")).status).toBe(503);
    const res = await post("nopass", "demo", "");
    expect(res.status).toBe(503);
    expect(res.headers.get("Set-Cookie")).toBeNull();
  });
});

describe("external mode (log in first, outside the viewer)", () => {
  it("success page keeps the tab open and links to the top page", async () => {
    const res = await post("extlogin", "demo", "pw-for-test");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).not.toContain("window.close");
    expect(html).toContain('href="/"');
    expect(res.headers.get("Set-Cookie")).toMatch(/^iiifcf_extlogin=/);
  });

  it("the cookie yields a token and the probe lets it through", async () => {
    const res = await post("extlogin", "demo", "pw-for-test");
    const cookie = (res.headers.get("Set-Cookie") ?? "").split(";")[0];
    const token = await getToken(cookie, "extlogin");
    const probe = await call("/probe/extlogin/m.glb", { headers: { Authorization: `Bearer ${token}` } });
    expect(((await probe.json()) as { status: number }).status).toBe(302);
    expect(((await (await call("/probe/extlogin/m.glb")).json()) as { status: number }).status).toBe(401);
  });

  it("without the cookie the token service says login is required", async () => {
    const t = await call(`/auth/token/extlogin?messageId=m1&origin=${encodeURIComponent("https://railclass.ldas.jp")}`);
    expect((await postedMessage(t))!.message.profile).toBe("missingAspect");
  });

  it("service block is external, has no id, and keeps token and logout", () => {
    const cfg = (env.COLLECTIONS as Record<string, CollectionConfig>).extlogin;
    const access = serviceBlock(BASE, "extlogin", "m.glb", cfg).service[0] as Record<string, unknown>;
    expect(access.profile).toBe("external");
    expect("id" in access).toBe(false);
    expect("confirmLabel" in access).toBe(false);
    const nested = access.service as { type: string }[];
    expect(nested.map((n) => n.type)).toEqual(["AuthAccessTokenService2", "AuthLogoutService2"]);
  });

  it("info.json carries the external service block", async () => {
    await env.FILES!.put("extlogin/image/pic/info.json", JSON.stringify({ id: "x", type: "ImageService3", width: 1, height: 1 }));
    const info = (await (await call("/image/extlogin/pic/info.json")).json()) as { service: { service: Record<string, unknown>[] }[] };
    expect(info.service[0].service[0].profile).toBe("external");
    expect("id" in info.service[0].service[0]).toBe(false);
  });
});

describe("POST is only for form logins", () => {
  it("is refused on the token service and the logout service", async () => {
    expect((await call("/auth/token/formlogin?messageId=m&origin=x", { method: "POST" })).status).toBe(404);
    expect((await call("/auth/logout/formlogin", { method: "POST" })).status).toBe(404);
  });

  it("is refused on a clickthrough collection's login, with no cookie", async () => {
    const res = await post("advisory", "demo", "x");
    expect(res.status).toBe(405);
    expect(res.headers.get("Set-Cookie")).toBeNull();
  });

  it("is refused on an Access collection's login", async () => {
    expect((await post("railclass", "a", "b")).status).toBe(405);
  });
});

describe("top page for form logins", () => {
  it("shows the credentials, and for external a first step linking to the login", async () => {
    const demos = [
      { type: "login", collection: "formlogin", image: "p", title: { en: ["L"] }, description: { en: ["d"] } },
      { type: "external", collection: "extlogin", image: "p", title: { en: ["E"] }, description: { en: ["d"] } },
    ];
    const { default: worker } = await import("../src/index.ts");
    const html = await (await worker.fetch(new Request(`${BASE}/`), { ...env, DEMOS: demos })).text();
    expect(html).toContain("<code>pw-for-test</code>");
    expect(html).toContain(`href="${BASE}/auth/login/extlogin"`);
    expect(html).not.toContain(`href="${BASE}/auth/login/formlogin"`);
  });
});
