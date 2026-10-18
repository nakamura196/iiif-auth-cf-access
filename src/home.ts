import { escapeHtml, htmlPage } from "./html.ts";
import type { CollectionConfig, Demo, Env } from "./types.ts";

/*
 * The showcase's top page: one entry per demo (env.DEMOS), each with its
 * manifest and links that open it in IIIF Auth 2.0 clients.
 * Deployments without DEMOS (e.g. RailClass) have no top page.
 */

// `models`: whether the client shows 3D (Presentation 4 Scenes).
const CLIENTS: { name: string; url: (manifest: string) => string; note: string; models: boolean }[] = [
  {
    name: "Kasane",
    url: (m) => `https://kasane.ldas.jp/viewer/?manifest=${encodeURIComponent(m)}`,
    note: "same site as this server (ldas.jp)",
    models: true,
  },
  {
    name: "IIIF Auth 2 client (tomcrane)",
    url: (m) => `https://tomcrane.github.io/iiif-auth-client/?manifest=${encodeURIComponent(m)}`,
    note: "another site (github.io): browsers that block third-party cookies will fail",
    models: false,
  },
];

const STYLE =
  "body{max-width:44rem}h2{margin-top:2.2rem;font-size:1.2rem}code{font-size:.9em;word-break:break-all}" +
  ".type{display:inline-block;font-size:.8rem;border:1px solid currentColor;border-radius:.3rem;padding:0 .4rem;margin-right:.4rem}" +
  "ul{padding-left:1.2rem}small{opacity:.75}";

export function parseDemos(env: Env): Demo[] {
  const raw = env.DEMOS;
  if (raw === undefined) return [];
  return typeof raw === "string" ? (JSON.parse(raw) as Demo[]) : raw;
}

const t = (m: Record<string, string[]>, lang: string) => (m[lang] ?? Object.values(m)[0] ?? []).join(" ");

export function homePage(origin: string, demos: Demo[], collections: Record<string, CollectionConfig> = {}): Response {
  const items = demos
    .map((d) => {
      const c = encodeURIComponent(d.collection);
      const manifest = `${origin}/manifest/${c}/${encodeURIComponent(d.image ?? d.model ?? "")}.json`;
      const cfg = Object.hasOwn(collections, d.collection) ? collections[d.collection] : undefined;
      const formMode = cfg?.mode === "login" || cfg?.mode === "external";
      const creds =
        formMode && cfg?.demoUser && cfg?.demoPassword
          ? `<p>Demo account (public) / 見本のアカウント（公開）: ID <code>${escapeHtml(cfg.demoUser)}</code> / Password <code>${escapeHtml(cfg.demoPassword)}</code></p>`
          : "";
      const first =
        cfg?.mode === "external"
          ? `<p><strong>1. <a href="${escapeHtml(`${origin}/auth/login/${c}`)}">Log in here first / まずここでログイン</a></strong></p><p><strong>2. Open in a viewer / ビューアで開く</strong></p>`
          : "";
      const clients = CLIENTS.filter((k) => d.image !== undefined || k.models)
        .map(
        (k) =>
          `<li><a href="${escapeHtml(k.url(manifest))}">${escapeHtml(k.name)}</a> <small>${escapeHtml(k.note)}</small></li>`,
      ).join("");
      return (
        `<h2><span class="type">${escapeHtml(d.type)}</span>${escapeHtml(t(d.title, "en"))} / ${escapeHtml(t(d.title, "ja"))}</h2>` +
        `<p>${escapeHtml(t(d.description, "en"))}<br>${escapeHtml(t(d.description, "ja"))}</p>` +
        creds +
        first +
        `<p>Manifest: <a href="${escapeHtml(manifest)}"><code>${escapeHtml(manifest)}</code></a></p>` +
        `<ul>${clients}</ul>` +
        `<p><small><a href="${origin}/auth/logout/${c}">Reset / やり直す</a> (clears this demo's cookie)</small></p>`
      );
    })
    .join("");
  return htmlPage({
    title: "IIIF Auth 2.0 demo",
    body:
      `<style>${STYLE}</style>` +
      "<h1>IIIF Auth 2.0 demo</h1>" +
      '<p>Working examples of the <a href="https://iiif.io/api/auth/2.0/">IIIF Authorization Flow API 2.0</a>, one per pattern. ' +
      "The images are public domain and the 3D models are open data; the access control is only there to show how the flow works.<br>" +
      "IIIF の認証（Authorization Flow API 2.0）の型を、1 つずつ試せる見本です。画像はパブリックドメイン、3D モデルはオープンデータです。制限は仕組みを見せるためだけに掛けています。</p>" +
      items +
      '<h2>Source</h2><p><a href="https://github.com/nakamura196/iiif-auth-cf-access">nakamura196/iiif-auth-cf-access</a> (MIT)</p>',
    headers: { "Cache-Control": "public, max-age=300" },
  });
}
