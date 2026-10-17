import { readCookie } from "./auth.ts";
import { SESSION_COOKIE_PREFIX, validPath } from "./config.ts";
import { verifyValue } from "./crypto.ts";
import { serviceBlock } from "./iiif.ts";
import { contentInfo } from "./mime.ts";
import { fileStore } from "./store.ts";
import type { CollectionConfig, Env, LanguageMap } from "./types.ts";

/*
 * IIIF Image API (level 0) services made of pre-cut tiles, stored as
 * "<collection>/image/<id>/..." (info.json, meta.json and the tiles that
 * `vips dzsave --layout iiif3` writes).
 *
 * - info.json is public. Its id and auth services are filled in per request,
 *   so the same files work on any host (and on localhost).
 * - Tiles need the session cookie of the collection. They are loaded by <img>,
 *   which sends cookies but cannot send a bearer token.
 * - The probe of an image answers 200 when the token is good (no location):
 *   the client then loads the tiles with the cookie.
 */

const CORS = { "Access-Control-Allow-Origin": "*" };

/** Descriptive metadata of one image, written next to its tiles as meta.json. */
export interface ImageMeta {
  label: LanguageMap;
  summary?: LanguageMap;
  requiredStatement?: { label: LanguageMap; value: LanguageMap };
  rights?: string;
  homepage?: { id: string; label: LanguageMap };
}

type Json = Record<string, unknown>;

const enc = encodeURIComponent;

/** Probe path (relative to the collection) of an image service. */
export const imageProbePath = (id: string) => `image/${id}/info.json`;

export function isImageProbePath(segs: string[]): boolean {
  return segs.length === 3 && segs[0] === "image" && segs[2] === "info.json";
}

function plain(status: number, text: string): Response {
  return new Response(text, {
    status,
    headers: { ...CORS, "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
  });
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { ...CORS, "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

async function readJson(env: Env, key: string): Promise<Json | null> {
  const body = await fileStore(env).get(key);
  return body ? ((await new Response(body).json()) as Json) : null;
}

export function imageServiceId(origin: string, c: string, id: string): string {
  return `${origin}/image/${enc(c)}/${enc(id)}`;
}

/** info.json with this host's id and the collection's auth services. */
export function imageService(info: Json, origin: string, c: string, id: string, cfg: CollectionConfig): Json {
  const others = (Array.isArray(info.service) ? (info.service as Json[]) : []).filter(
    (s) => s.type !== "AuthProbeService2",
  );
  return {
    ...info,
    id: imageServiceId(origin, c, id),
    service: [...others, serviceBlock(origin, c, imageProbePath(id), cfg)],
  };
}

/**
 * "x,y,w,h/W,/..." -> "x,y,w,h/W,H/..." with H as vips computes it: the tile
 * is the region shrunk by a power-of-two scale factor, each side rounded up.
 */
export function withHeight(rest: string[]): string[] | null {
  if (rest.length !== 4) return null;
  const region = rest[0].match(/^\d+,\d+,(\d+),(\d+)$/);
  const size = rest[1].match(/^(\d+),$/);
  if (!region || !size) return null;
  const [rw, rh, w] = [Number(region[1]), Number(region[2]), Number(size[1])];
  for (let s = 1; s <= 1024; s *= 2) {
    if (Math.ceil(rw / s) === w) return [rest[0], `${w},${Math.ceil(rh / s)}`, rest[2], rest[3]];
  }
  return null;
}

export async function handleImage(
  request: Request,
  env: Env,
  c: string,
  cfg: CollectionConfig,
  segs: (string | null)[],
  now: number,
): Promise<Response> {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: { ...CORS, "Access-Control-Allow-Methods": "GET, OPTIONS" } });
  }
  if (!validPath(segs) || segs.length < 1) return plain(404, "Not found");
  const [id, ...rest] = segs;
  const origin = new URL(request.url).origin;

  // The base URI of an image service redirects to its info.json (Image API 3, 2.1).
  if (rest.length === 0) {
    return new Response(null, {
      status: 303,
      headers: { ...CORS, Location: `${imageServiceId(origin, c, id)}/info.json`, "Cache-Control": "no-store" },
    });
  }

  if (rest.length === 1 && rest[0] === "info.json") {
    const info = await readJson(env, `${c}/image/${id}/info.json`);
    if (!info) return plain(404, "Not found");
    return json(imageService(info, origin, c, id, cfg));
  }
  if (rest[rest.length - 1] === "meta.json") return plain(404, "Not found");

  const cookie = readCookie(request, `${SESSION_COOKIE_PREFIX}${c}`);
  const verdict = cookie ? await verifyValue(env.SIGNING_KEY, cookie, "session", c, now) : null;
  if (!verdict || !verdict.ok) return plain(401, "Unauthorized");

  const key = `${c}/image/${id}/${rest.join("/")}`;
  const store = fileStore(env);
  let body = await store.get(key);
  if (!body) {
    // Clients often ask for "w," (e.g. OpenSeadragon); the tiles are stored as "w,h".
    const alt = withHeight(rest);
    if (alt) body = await store.get(`${c}/image/${id}/${alt.join("/")}`);
  }
  if (!body) return plain(404, "Not found");
  return new Response(body, {
    headers: { ...CORS, "Content-Type": contentInfo(key).format, "Cache-Control": "private, max-age=3600" },
  });
}

/** A one-canvas Presentation 3 manifest for the image. */
export async function handleManifest(
  request: Request,
  env: Env,
  c: string,
  cfg: CollectionConfig,
  id: string,
): Promise<Response> {
  const [info, meta] = await Promise.all([
    readJson(env, `${c}/image/${id}/info.json`),
    readJson(env, `${c}/image/${id}/meta.json`) as Promise<ImageMeta | null>,
  ]);
  if (!info || !meta) return plain(404, "Not found");
  const origin = new URL(request.url).origin;
  const base = `${origin}/manifest/${enc(c)}/${enc(id)}`;
  const service = imageService(info, origin, c, id, cfg);
  const { width, height } = info as { width: number; height: number };
  // The largest pre-made size stands for the whole image (level 0 has no full/max).
  const sizes = (Array.isArray(info.sizes) ? info.sizes : []) as { width: number; height: number }[];
  const full = sizes.reduce<{ width: number; height: number } | null>(
    (best, s) => (!best || s.width > best.width ? s : best),
    null,
  );
  const canvas = `${base}/canvas/1`;
  return json({
    "@context": "http://iiif.io/api/presentation/3/context.json",
    id: `${base}.json`,
    type: "Manifest",
    label: meta.label,
    ...(meta.summary ? { summary: meta.summary } : {}),
    ...(meta.requiredStatement ? { requiredStatement: meta.requiredStatement } : {}),
    ...(meta.rights ? { rights: meta.rights } : {}),
    ...(meta.homepage ? { homepage: [{ ...meta.homepage, type: "Text", format: "text/html" }] } : {}),
    items: [
      {
        id: canvas,
        type: "Canvas",
        width,
        height,
        items: [
          {
            id: `${base}/page/1`,
            type: "AnnotationPage",
            items: [
              {
                id: `${base}/annotation/1`,
                type: "Annotation",
                motivation: "painting",
                target: canvas,
                body: {
                  id: full
                    ? `${service.id}/full/${full.width},${full.height}/0/default.jpg`
                    : `${service.id}/full/max/0/default.jpg`,
                  type: "Image",
                  format: "image/jpeg",
                  width,
                  height,
                  service: [service],
                },
              },
            ],
          },
        ],
      },
    ],
  });
}
