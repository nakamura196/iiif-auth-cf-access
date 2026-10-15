import { describe, expect, it } from "vitest";
import { fileStore } from "../src/store.ts";
import type { Env } from "../src/types.ts";

const BYTES = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);

/** Fake static-assets binding holding one file at /railclass/a b.glb. */
function fakeAssets(opts: { honourRange: boolean; headLength: boolean }): Fetcher {
  return {
    async fetch(input: RequestInfo | URL, init?: RequestInit) {
      const req = new Request(input, init);
      const path = decodeURIComponent(new URL(req.url).pathname);
      if (path !== "/railclass/a b.glb") return new Response("nope", { status: 404 });
      const headers: Record<string, string> = { ETag: '"e1"' };
      if (req.method === "HEAD") {
        if (opts.headLength) headers["Content-Length"] = String(BYTES.length);
        return new Response(null, { status: 200, headers });
      }
      const m = /^bytes=(\d+)-(\d+)$/.exec(req.headers.get("Range") ?? "");
      if (m && opts.honourRange) return new Response(BYTES.slice(Number(m[1]), Number(m[2]) + 1), { status: 206, headers });
      return new Response(BYTES, { status: 200, headers });
    },
    connect() {
      throw new Error("unused");
    },
  } as unknown as Fetcher;
}

const read = async (s: ReadableStream | null) => new Uint8Array(await new Response(s).arrayBuffer());

describe("static assets store", () => {
  for (const honourRange of [true, false]) {
    it(`head, get and range (binding ${honourRange ? "honours" : "ignores"} Range)`, async () => {
      const store = fileStore({ ASSETS: fakeAssets({ honourRange, headLength: true }) } as Env);
      expect(await store.head("railclass/a b.glb")).toEqual({ size: 10, etag: '"e1"' });
      expect(await store.head("railclass/missing.glb")).toBeNull();
      expect(await read(await store.get("railclass/a b.glb"))).toEqual(BYTES);
      expect(await read(await store.get("railclass/a b.glb", [2, 5]))).toEqual(BYTES.slice(2, 6));
      expect(await store.get("railclass/missing.glb")).toBeNull();
    });
  }

  it("measures the size when HEAD has no Content-Length", async () => {
    const store = fileStore({ ASSETS: fakeAssets({ honourRange: true, headLength: false }) } as Env);
    expect((await store.head("railclass/a b.glb"))?.size).toBe(10);
  });

  it("fails loudly when no store is bound", () => {
    expect(() => fileStore({} as Env)).toThrow(/No file store/);
  });
});
