import { beforeAll, describe, expect, it } from "vitest";
import { BASE, call, env, getToken } from "./helpers.ts";
import { withHeight } from "../src/images.ts";

const INFO = {
  "@context": "http://iiif.io/api/image/3/context.json",
  id: "https://placeholder.invalid/image/advisory/pic",
  type: "ImageService3",
  profile: "level0",
  protocol: "http://iiif.io/api/image",
  tiles: [{ scaleFactors: [1, 2], width: 512 }],
  sizes: [{ width: 100, height: 80 }],
  width: 1000,
  height: 800,
};
const META = { label: { en: ["A picture"] }, rights: "http://creativecommons.org/publicdomain/mark/1.0/" };
const TILE = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);

async function agree(): Promise<string> {
  const res = await call("/auth/login/advisory");
  return (res.headers.get("Set-Cookie") ?? "").split(";")[0];
}

beforeAll(async () => {
  await env.FILES!.put("advisory/image/pic/info.json", JSON.stringify(INFO));
  await env.FILES!.put("advisory/image/pic/meta.json", JSON.stringify(META));
  await env.FILES!.put("advisory/image/pic/0,0,512,512/512,/0/default.jpg", TILE);
});

describe("image service", () => {
  it("info.json is public, with this host's id and the auth services", async () => {
    const res = await call("/image/advisory/pic/info.json");
    expect(res.status).toBe(200);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    const info = (await res.json()) as { id: string; service: { id: string; type: string }[] };
    expect(info.id).toBe(`${BASE}/image/advisory/pic`);
    expect(info.service).toHaveLength(1);
    expect(info.service[0]).toMatchObject({ type: "AuthProbeService2", id: `${BASE}/probe/advisory/image/pic/info.json` });
  });

  it("the service id redirects to info.json", async () => {
    const res = await call("/image/advisory/pic");
    expect(res.status).toBe(303);
    expect(res.headers.get("Location")).toBe(`${BASE}/image/advisory/pic/info.json`);
  });

  it("a tile needs the cookie", async () => {
    expect((await call("/image/advisory/pic/0,0,512,512/512,/0/default.jpg")).status).toBe(401);
    const cookie = await agree();
    const res = await call("/image/advisory/pic/0,0,512,512/512,/0/default.jpg", { headers: { Cookie: cookie } });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/jpeg");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(TILE);
  });

  it("a tile asked for as \"w,\" is served from the \"w,h\" file", async () => {
    await env.FILES!.put("advisory/image/pic/512,0,488,800/244,400/0/default.jpg", TILE);
    const cookie = await agree();
    const res = await call("/image/advisory/pic/512,0,488,800/244,/0/default.jpg", { headers: { Cookie: cookie } });
    expect(res.status).toBe(200);
    expect(withHeight(["0,0,1024,1024", "512,", "0", "default.jpg"])).toEqual(["0,0,1024,1024", "512,512", "0", "default.jpg"]);
    expect(withHeight(["8192,0,509,1024", "255,", "0", "default.jpg"])).toEqual(["8192,0,509,1024", "255,512", "0", "default.jpg"]);
    expect(withHeight(["full", "512,", "0", "default.jpg"])).toBeNull();
  });

  it("another collection's cookie does not open the tiles", async () => {
    const value = (await agree()).split("=")[1];
    const res = await call("/image/advisory/pic/0,0,512,512/512,/0/default.jpg", {
      headers: { Cookie: `iiifcf_railclass=${value}` },
    });
    expect(res.status).toBe(401);
  });

  it("meta.json is not served, and unknown ids are 404", async () => {
    const cookie = await agree();
    expect((await call("/image/advisory/pic/meta.json", { headers: { Cookie: cookie } })).status).toBe(404);
    expect((await call("/image/advisory/nope/info.json")).status).toBe(404);
    expect((await call("/image/unknown/pic/info.json")).status).toBe(404);
  });

  it("probe: 401 without a token, 200 (no location) with one", async () => {
    const before = (await (await call("/probe/advisory/image/pic/info.json")).json()) as { status: number };
    expect(before.status).toBe(401);
    const token = await getToken(await agree(), "advisory");
    const after = (await (
      await call("/probe/advisory/image/pic/info.json", { headers: { Authorization: `Bearer ${token}` } })
    ).json()) as { status: number; location?: unknown };
    expect(after.status).toBe(200);
    expect(after.location).toBeUndefined();
  });
});

describe("manifest", () => {
  it("builds a one-canvas manifest around the image service", async () => {
    const res = await call("/manifest/advisory/pic.json");
    expect(res.status).toBe(200);
    const m = (await res.json()) as any;
    expect(m.id).toBe(`${BASE}/manifest/advisory/pic.json`);
    expect(m.label).toEqual(META.label);
    expect(m.rights).toBe(META.rights);
    const canvas = m.items[0];
    expect([canvas.width, canvas.height]).toEqual([1000, 800]);
    const body = canvas.items[0].items[0].body;
    expect(body.id).toBe(`${BASE}/image/advisory/pic/full/100,80/0/default.jpg`);
    expect(body.service[0].service[0].type).toBe("AuthProbeService2");
  });

  it("404 for an unknown image", async () => {
    expect((await call("/manifest/advisory/nope.json")).status).toBe(404);
  });
});

describe("top page", () => {
  it("is 404 without DEMOS", async () => {
    expect((await call("/")).status).toBe(404);
  });

  it("lists the demos with client links", async () => {
    const demos = [
      { type: "clickthrough", collection: "advisory", image: "pic", title: { en: ["Agree"] }, description: { en: ["d"] } },
    ];
    const { default: worker } = await import("../src/index.ts");
    const res = await worker.fetch(new Request(`${BASE}/`), { ...env, DEMOS: demos });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain(`${BASE}/manifest/advisory/pic.json`);
    expect(html).toContain(`https://kasane.ldas.jp/?manifest=${encodeURIComponent(`${BASE}/manifest/advisory/pic.json`)}`);
    expect(html).toContain("tomcrane.github.io/iiif-auth-client/?manifest=");
  });
});
