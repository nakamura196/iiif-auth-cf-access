import { beforeAll, describe, expect, it } from "vitest";
import { BASE, call, env, getToken } from "./helpers.ts";

const META = { label: { en: ["Points"] }, requiredStatement: { label: { en: ["Attribution"] }, value: { en: ["Someone"] } } };
const FULL = new Uint8Array([0x67, 0x6c, 0x54, 0x46, 1, 1, 1, 1]);
const LIGHT = new Uint8Array([0x67, 0x6c, 0x54, 0x46, 2]);
const SUB = `${BASE}/files/graded/model/pts-degraded/model.glb`;

async function agree(c: string): Promise<string> {
  const res = await call(`/auth/login/${c}`);
  return (res.headers.get("Set-Cookie") ?? "").split(";")[0];
}

async function probe(path: string, token?: string): Promise<Record<string, any>> {
  const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};
  return (await (await call(`/probe/${path}`, { headers })).json()) as Record<string, any>;
}

beforeAll(async () => {
  await env.FILES!.put("graded/model/pts/model.glb", FULL);
  await env.FILES!.put("graded/model/pts/meta.json", JSON.stringify(META));
  await env.FILES!.put("graded/model/pts-degraded/model.glb", LIGHT);
  await env.FILES!.put("graded/model/lone/model.glb", FULL);
  await env.FILES!.put("advisory/model/pts/model.glb", FULL);
  await env.FILES!.put("advisory/model/pts-degraded/model.glb", LIGHT);
});

describe("3D model, degraded access", () => {
  it("probe: 401 with the lighter copy as substitute, then 302 to the signed full model", async () => {
    const before = await probe("graded/model/pts/model.glb");
    expect(before.status).toBe(401);
    expect(before.substitute).toEqual([
      { id: SUB, type: "Model", format: "model/gltf-binary", label: { en: ["Small greyscale copy"] } },
    ]);
    const token = await getToken(await agree("graded"), "graded");
    const after = await probe("graded/model/pts/model.glb", token);
    expect(after.status).toBe(302);
    expect(after.substitute).toBeUndefined();
    const full = await call(new URL(after.location.id).pathname + new URL(after.location.id).search);
    expect(full.status).toBe(200);
    expect(new Uint8Array(await full.arrayBuffer())).toEqual(FULL);
  });

  it("the copy is served without a signature; the full model is not", async () => {
    const res = await call("/files/graded/model/pts-degraded/model.glb");
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=3600");
    expect(res.headers.get("Content-Type")).toBe("model/gltf-binary");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(LIGHT);
    expect((await call("/files/graded/model/pts/model.glb")).status).toBe(403);
    expect((await call("/files/graded/model/pts/meta.json")).status).toBe(403);
  });

  it("no substitute when the copy is missing or the collection has none", async () => {
    expect((await probe("graded/model/lone/model.glb")).substitute).toBeUndefined();
    expect((await probe("advisory/model/pts/model.glb")).substitute).toBeUndefined();
    // Without substituteLabel, "-degraded" is an ordinary, protected file.
    expect((await call("/files/advisory/model/pts-degraded/model.glb")).status).toBe(403);
  });
});

describe("3D model manifest", () => {
  it("builds a one-scene manifest with the model and its auth services", async () => {
    const res = await call("/manifest/graded/pts.json");
    expect(res.status).toBe(200);
    const m = (await res.json()) as any;
    expect(m["@context"]).toBe("http://iiif.io/api/presentation/4/context.json");
    expect(m.id).toBe(`${BASE}/manifest/graded/pts.json`);
    expect(m.label).toEqual(META.label);
    expect(m.requiredStatement).toEqual(META.requiredStatement);
    const scene = m.items[0];
    expect(scene.type).toBe("Scene");
    const body = scene.items[0].items[0].body;
    expect(body).toMatchObject({ id: `${BASE}/files/graded/model/pts/model.glb`, type: "Model", format: "model/gltf-binary" });
    expect(body.service[0]).toMatchObject({ id: `${BASE}/probe/graded/model/pts/model.glb`, type: "AuthProbeService2" });
  });

  it("404 without meta.json, and for the copy itself", async () => {
    expect((await call("/manifest/graded/lone.json")).status).toBe(404);
    expect((await call("/manifest/graded/pts-degraded.json")).status).toBe(404);
  });
});
