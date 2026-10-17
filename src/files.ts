import { validPath } from "./config.ts";
import { hmacVerify } from "./crypto.ts";
import { contentInfo } from "./mime.ts";
import { fileSignatureInput } from "./probe.ts";
import { isPublicModelPath } from "./models.ts";
import { fileStore } from "./store.ts";
import type { CollectionConfig, Env } from "./types.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Expose-Headers": "Content-Length, Content-Range, Accept-Ranges, ETag",
};

function plain(status: number, text: string, extra: Record<string, string> = {}): Response {
  return new Response(text, {
    status,
    headers: { ...CORS, "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", ...extra },
  });
}

/** Returns [start, end] inclusive, "unsatisfiable", or null (ignore header). */
export function parseRange(header: string | null, size: number): [number, number] | "unsatisfiable" | null {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === "" && m[2] === "")) return null; // malformed or multi-range: serve whole file
  if (m[1] === "") {
    const n = Number(m[2]);
    if (n === 0) return "unsatisfiable";
    return size === 0 ? "unsatisfiable" : [Math.max(0, size - n), size - 1];
  }
  const start = Number(m[1]);
  const end = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1);
  if (start >= size || start > end) return "unsatisfiable";
  return [start, end];
}

export async function handleFiles(
  request: Request,
  env: Env,
  c: string,
  cfg: CollectionConfig,
  segs: (string | null)[],
  now: number,
): Promise<Response> {
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: { ...CORS, "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS", "Access-Control-Allow-Headers": "Range" },
    });
  }
  if (!validPath(segs)) return plain(404, "Not found");
  const path = segs.join("/");

  // A degraded copy (the probe's substitute) is public; everything else needs a signed URL.
  let cacheControl = "public, max-age=3600";
  if (!isPublicModelPath(segs, cfg)) {
    const q = new URL(request.url).searchParams;
    const expStr = q.get("exp");
    const sig = q.get("sig");
    if (!expStr || !sig || !/^\d{1,12}$/.test(expStr)) return plain(403, "Forbidden");
    const exp = Number(expStr);
    if (!(await hmacVerify(env.SIGNING_KEY, fileSignatureInput(c, path, exp), sig))) return plain(403, "Forbidden");
    if (exp <= now) return plain(403, "Expired");
    cacheControl = `private, max-age=${exp - now}`;
  }

  const key = `${c}/${path}`;
  const store = fileStore(env);
  const head = await store.head(key);
  if (!head) return plain(404, "Not found");

  const headers: Record<string, string> = {
    ...CORS,
    "Content-Type": contentInfo(path).format,
    "Accept-Ranges": "bytes",
    ...(head.etag ? { ETag: head.etag } : {}),
    "Cache-Control": cacheControl,
  };

  const range = parseRange(request.headers.get("Range"), head.size);
  if (range === "unsatisfiable") {
    return new Response(null, { status: 416, headers: { ...headers, "Content-Range": `bytes */${head.size}` } });
  }

  if (range) {
    const [start, end] = range;
    const length = end - start + 1;
    headers["Content-Range"] = `bytes ${start}-${end}/${head.size}`;
    headers["Content-Length"] = String(length);
    if (request.method === "HEAD") return new Response(null, { status: 206, headers });
    const body = await store.get(key, [start, end]);
    if (!body) return plain(404, "Not found");
    return new Response(body, { status: 206, headers });
  }

  headers["Content-Length"] = String(head.size);
  if (request.method === "HEAD") return new Response(null, { status: 200, headers });
  const body = await store.get(key);
  if (!body) return plain(404, "Not found");
  return new Response(body, { status: 200, headers });
}
