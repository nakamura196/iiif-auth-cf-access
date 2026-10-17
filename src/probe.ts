import { fileUrlExpiry, validPath } from "./config.ts";
import { hmacSign, verifyValue } from "./crypto.ts";
import { encodePath } from "./iiif.ts";
import { imageSubstitute, isImageProbePath } from "./images.ts";
import { contentInfo } from "./mime.ts";
import { isModelPath, modelSubstitute } from "./models.ts";
import { fileStore } from "./store.ts";
import type { CollectionConfig, Env } from "./types.ts";

const CONTEXT = "http://iiif.io/api/auth/2/context.json";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Authorization",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Max-Age": "86400",
};

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200, // the spec requires HTTP 200; the real status is in the body
    headers: { ...CORS, "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

export function fileSignatureInput(c: string, path: string, exp: number): string {
  return `files/${c}/${path}|${exp}`;
}

export async function handleProbe(
  request: Request,
  env: Env,
  c: string,
  cfg: CollectionConfig,
  segs: (string | null)[],
  now: number,
): Promise<Response> {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

  const auth = request.headers.get("Authorization") ?? "";
  const m = /^Bearer\s+(\S+)$/i.exec(auth);
  const verdict = m ? await verifyValue(env.SIGNING_KEY, m[1], "token", c, now) : null;
  if (!verdict || !verdict.ok) {
    // Degraded access: the client shows the substitute and still offers the access service.
    const origin = new URL(request.url).origin;
    const substitute = !validPath(segs)
      ? null
      : isImageProbePath(segs)
        ? await imageSubstitute(env, origin, c, segs[1], cfg)
        : isModelPath(segs)
          ? await modelSubstitute(env, origin, c, segs[1], cfg)
          : null;
    return json({
      "@context": CONTEXT,
      type: "AuthProbeResult2",
      status: 401,
      ...(substitute ? { substitute } : {}),
      heading: cfg.heading,
      note: cfg.note,
    });
  }

  if (!validPath(segs)) return json({ "@context": CONTEXT, type: "AuthProbeResult2", status: 404 });
  const path = segs.join("/");
  const head = await fileStore(env).head(`${c}/${path}`);
  if (!head) return json({ "@context": CONTEXT, type: "AuthProbeResult2", status: 404 });

  // An image service: the tiles are read with the session cookie, so there is nothing to hand over.
  if (isImageProbePath(segs)) return json({ "@context": CONTEXT, type: "AuthProbeResult2", status: 200 });

  const exp = fileUrlExpiry(now);
  const sig = await hmacSign(env.SIGNING_KEY, fileSignatureInput(c, path, exp));
  const origin = new URL(request.url).origin;
  const info = contentInfo(path);
  return json({
    "@context": CONTEXT,
    type: "AuthProbeResult2",
    status: 302,
    location: {
      id: `${origin}/files/${encodeURIComponent(c)}/${encodePath(path)}?exp=${exp}&sig=${sig}`,
      type: info.type,
      format: info.format,
    },
  });
}
