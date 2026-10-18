import { handleFiles } from "./files.ts";
import { handleLogin, handleLogout, handleToken } from "./auth.ts";
import { homePage, parseDemos } from "./home.ts";
import { handleImage, handleManifest } from "./images.ts";
import { handleProbe } from "./probe.ts";
import { parseCollections } from "./config.ts";
import type { Env } from "./types.ts";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // Refuse to run with a missing or weak key: everything is signed with it.
    if (typeof env.SIGNING_KEY !== "string" || env.SIGNING_KEY.length < 32) {
      console.error("SIGNING_KEY is missing or shorter than 32 characters");
      return new Response("Server not configured", { status: 500, headers: { "Cache-Control": "no-store" } });
    }
    try {
      return await route(request, env);
    } catch (err) {
      console.error("unhandled", err instanceof Error ? err.message : String(err));
      return new Response("Internal error", { status: 500, headers: { "Cache-Control": "no-store" } });
    }
  },
} satisfies ExportedHandler<Env>;

function notFound(): Response {
  return new Response("Not found", { status: 404, headers: { "Cache-Control": "no-store" } });
}

async function route(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const method = request.method;
  const segs = url.pathname.split("/"); // ["", "auth", "login", "<c>"]
  const collections = parseCollections(env);
  const now = Math.floor(Date.now() / 1000);

  const [, area, second, third] = segs;

  if (area === "auth" && segs.length === 4 && (method === "GET" || (method === "POST" && second === "login"))) {
    const c = decodeSeg(third);
    const cfg = c !== null && Object.hasOwn(collections, c) ? collections[c] : null;
    if (!c || !cfg) return notFound();
    if (second === "login") return handleLogin(request, env, c, cfg, now);
    if (second === "token") return handleToken(request, env, c, cfg, now);
    if (second === "logout") return handleLogout(env, c, cfg);
    return notFound();
  }

  if (area === "probe" && segs.length >= 4 && (method === "GET" || method === "OPTIONS")) {
    const c = decodeSeg(second);
    if (!c || !Object.hasOwn(collections, c)) return notFound();
    const path = segs.slice(3).map(decodeSeg);
    return handleProbe(request, env, c, collections[c], path, now);
  }

  if (area === "image" && segs.length >= 4 && (method === "GET" || method === "OPTIONS")) {
    const c = decodeSeg(second);
    if (!c || !Object.hasOwn(collections, c)) return notFound();
    return handleImage(request, env, c, collections[c], segs.slice(3).map(decodeSeg), now);
  }

  if (area === "manifest" && segs.length === 4 && method === "GET" && third.endsWith(".json")) {
    const c = decodeSeg(second);
    const id = decodeSeg(third.slice(0, -".json".length));
    if (!c || !id || !Object.hasOwn(collections, c)) return notFound();
    return handleManifest(request, env, c, collections[c], id);
  }

  if (url.pathname === "/" && method === "GET") {
    const demos = parseDemos(env);
    if (demos.length) return homePage(url.origin, demos, collections);
  }

  if (area === "files" && segs.length >= 4 && (method === "GET" || method === "HEAD" || method === "OPTIONS")) {
    const c = decodeSeg(second);
    if (!c || !Object.hasOwn(collections, c)) return notFound();
    const path = segs.slice(3).map(decodeSeg);
    return handleFiles(request, env, c, collections[c], path, now);
  }

  return notFound();
}

function decodeSeg(s: string): string | null {
  try {
    return decodeURIComponent(s);
  } catch {
    return null;
  }
}
