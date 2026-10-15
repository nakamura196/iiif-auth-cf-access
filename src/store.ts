import type { Env } from "./types.ts";

/**
 * Where the protected files live. Two backends:
 * - R2 (binding FILES): private bucket, keys "<collection>/<path>".
 * - Workers Static Assets (binding ASSETS, with run_worker_first: true):
 *   files deployed with the Worker under "<collection>/<path>". No R2 needed.
 */
export interface FileStore {
  head(key: string): Promise<{ size: number; etag: string } | null>;
  /** Whole file, or [start, end] inclusive. */
  get(key: string, range?: [number, number]): Promise<ReadableStream | null>;
}

export function fileStore(env: Env): FileStore {
  if (env.FILES) return r2Store(env.FILES);
  if (env.ASSETS) return assetsStore(env.ASSETS);
  throw new Error("No file store: bind an R2 bucket as FILES or static assets as ASSETS");
}

function r2Store(bucket: R2Bucket): FileStore {
  return {
    async head(key) {
      const h = await bucket.head(key);
      return h ? { size: h.size, etag: h.httpEtag } : null;
    },
    async get(key, range) {
      const obj = range
        ? await bucket.get(key, { range: { offset: range[0], length: range[1] - range[0] + 1 } })
        : await bucket.get(key);
      return obj && "body" in obj ? obj.body : null;
    },
  };
}

// The host is ignored by the assets binding; only the path is used.
const assetUrl = (key: string) => `https://assets.invalid/${key.split("/").map(encodeURIComponent).join("/")}`;

function assetsStore(assets: Fetcher): FileStore {
  return {
    async head(key) {
      const res = await assets.fetch(assetUrl(key), { method: "HEAD" });
      if (res.status !== 200) return null;
      const len = res.headers.get("Content-Length");
      // HEAD without a length: read the body once to measure it (files are small, ≤ 25 MiB).
      const size = len !== null ? Number(len) : (await (await assets.fetch(assetUrl(key))).arrayBuffer()).byteLength;
      return { size, etag: res.headers.get("ETag") ?? "" };
    },
    async get(key, range) {
      if (!range) {
        const res = await assets.fetch(assetUrl(key));
        return res.status === 200 ? res.body : null;
      }
      const [start, end] = range;
      const res = await assets.fetch(assetUrl(key), { headers: { Range: `bytes=${start}-${end}` } });
      if (res.status === 206) return res.body;
      if (res.status !== 200) return null;
      // Range not honoured: cut the slice ourselves.
      const buf = await res.arrayBuffer();
      return new Response(buf.slice(start, end + 1)).body;
    },
  };
}
