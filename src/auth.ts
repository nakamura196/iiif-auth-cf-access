import { verifyAccessJwt } from "./access.ts";
import { SESSION_COOKIE_PREFIX, TOKEN_LIFETIME } from "./config.ts";
import { signValue, verifyValue } from "./crypto.ts";
import { escapeHtml, htmlPage, safeJson } from "./html.ts";
import type { CollectionConfig, Env } from "./types.ts";

export function cookieAttrs(maxAge: number): string {
  return `Path=/; Secure; HttpOnly; SameSite=None; Max-Age=${maxAge}`;
}

export function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get("Cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

/* ---------- AuthAccessService2 (login) ---------- */

export async function handleLogin(
  request: Request,
  env: Env,
  c: string,
  cfg: CollectionConfig,
  now: number,
): Promise<Response> {
  if (request.method === "POST" && cfg.mode !== "login" && cfg.mode !== "external") {
    return htmlPage({ status: 405, title: "Method not allowed", body: "<h1>Method not allowed</h1>", headers: { Allow: "GET" } });
  }
  if (cfg.mode === "login" || cfg.mode === "external") return handleFormLogin(request, env, c, cfg, now);
  if (cfg.mode === "clickthrough") {
    const session = await signValue(env.SIGNING_KEY, { typ: "session", c, sub: "clickthrough", exp: now + cfg.cookieMaxAge });
    return htmlPage({
      title: "Agreed",
      body: "<h1>Thank you / ありがとうございます</h1><p>You can close this window.<br>このウィンドウを閉じてください。</p>",
      script: "window.close();",
      headers: { "Set-Cookie": `${SESSION_COOKIE_PREFIX}${c}=${session}; ${cookieAttrs(cfg.cookieMaxAge)}` },
    });
  }
  let email: string | null;
  try {
    email = await verifyAccessJwt(request.headers.get("Cf-Access-Jwt-Assertion"), env.ACCESS_TEAM_DOMAIN, cfg.aud ?? "", now);
  } catch (err) {
    console.error("access verification unavailable", err instanceof Error ? err.message : String(err));
    return htmlPage({
      status: 503,
      title: "Unavailable",
      body: "<h1>Temporarily unavailable / 一時的に利用できません</h1><p>Please try again later.<br>しばらくしてからもう一度お試しください。</p>",
    });
  }
  if (!email) {
    return htmlPage({
      status: 403,
      title: "Forbidden",
      body: "<h1>Access denied / アクセスできません</h1><p>Your login could not be verified.<br>ログインを確認できませんでした。</p>",
    });
  }
  const session = await signValue(env.SIGNING_KEY, {
    typ: "session",
    c,
    sub: email,
    exp: now + cfg.cookieMaxAge,
  });
  return htmlPage({
    title: "Logged in",
    body:
      "<h1>Logged in / ログインしました</h1><p>You can close this window.<br>このウィンドウを閉じてください。</p>",
    script: "window.close();",
    headers: { "Set-Cookie": `${SESSION_COOKIE_PREFIX}${c}=${session}; ${cookieAttrs(cfg.cookieMaxAge)}` },
  });
}

/* ---------- form login ("login" and "external" modes) ---------- */

const t = (m: Record<string, string[]>, lang: string) => (m[lang] ?? Object.values(m)[0] ?? []).join(" ");

/** Compare in time that does not depend on where the strings differ. */
function sameText(a: string, b: string): boolean {
  const ea = new TextEncoder().encode(a);
  const eb = new TextEncoder().encode(b);
  let diff = ea.length ^ eb.length;
  for (let i = 0; i < Math.max(ea.length, eb.length); i++) diff |= (ea[i] ?? 0) ^ (eb[i] ?? 0);
  return diff === 0;
}

function loginForm(c: string, cfg: CollectionConfig, user: string, password: string, error: boolean): Response {
  const body =
    `<h1>${escapeHtml(t(cfg.heading, "en"))} / ${escapeHtml(t(cfg.heading, "ja"))}</h1>` +
    `<p>${escapeHtml(t(cfg.note, "en"))}<br>${escapeHtml(t(cfg.note, "ja"))}</p>` +
    (error
      ? '<p role="alert"><strong>The ID or password is wrong. / ID またはパスワードが違います。</strong></p>'
      : "") +
    `<p>Demo account (public) / 見本のアカウント（公開）:<br>ID: <code>${escapeHtml(user)}</code> / Password: <code>${escapeHtml(password)}</code></p>` +
    `<form method="post" action="/auth/login/${encodeURIComponent(c)}">` +
    '<p><label>ID<br><input name="username" autocomplete="username" required></label></p>' +
    '<p><label>Password / パスワード<br><input name="password" type="password" autocomplete="current-password" required></label></p>' +
    '<p><button type="submit">Log in / ログイン</button></p></form>';
  return htmlPage({ status: error ? 401 : 200, title: "Log in", body });
}

async function handleFormLogin(
  request: Request,
  env: Env,
  c: string,
  cfg: CollectionConfig,
  now: number,
): Promise<Response> {
  const user = cfg.demoUser;
  const password = cfg.demoPassword;
  if (!user || !password) {
    console.error(`collection ${c}: demoUser / demoPassword are not set`);
    return htmlPage({
      status: 503,
      title: "Unavailable",
      body: "<h1>Temporarily unavailable / 一時的に利用できません</h1><p>This login is not configured.<br>このログインは設定されていません。</p>",
    });
  }
  if (request.method !== "POST") return loginForm(c, cfg, user, password, false);

  let username = "";
  let given = "";
  try {
    const form = await request.formData();
    const u = form.get("username");
    const p = form.get("password");
    if (typeof u === "string") username = u;
    if (typeof p === "string") given = p;
  } catch {
    // not a form: treated as wrong credentials
  }
  const okUser = sameText(username, user);
  const okPass = sameText(given, password);
  if (!(okUser && okPass)) return loginForm(c, cfg, user, password, true);

  const session = await signValue(env.SIGNING_KEY, { typ: "session", c, sub: username, exp: now + cfg.cookieMaxAge });
  const headers = { "Set-Cookie": `${SESSION_COOKIE_PREFIX}${c}=${session}; ${cookieAttrs(cfg.cookieMaxAge)}` };
  if (cfg.mode === "external") {
    return htmlPage({
      title: "Logged in",
      body:
        "<h1>Logged in / ログインしました</h1>" +
        "<p>Now go back to the viewer and open it (or reload it).<br>ビューアに戻って、開く（または再読み込みする）と見られます。</p>" +
        '<p><a href="/">Back to the top page / トップページへ</a></p>',
      headers,
    });
  }
  return htmlPage({
    title: "Logged in",
    body: "<h1>Logged in / ログインしました</h1><p>You can close this window.<br>このウィンドウを閉じてください。</p>",
    script: "window.close();",
    headers,
  });
}

/* ---------- AuthLogoutService2 ---------- */

export function handleLogout(env: Env, c: string, cfg: CollectionConfig): Response {
  const clear = { "Set-Cookie": `${SESSION_COOKIE_PREFIX}${c}=; ${cookieAttrs(0)}` };
  if (cfg.mode === "clickthrough") {
    return htmlPage({
      title: "Reset",
      body: "<h1>Reset / 取り消しました</h1><p>You will be asked to agree again.<br>次に開くときは、もう一度確認します。</p>",
      headers: clear,
    });
  }
  if (cfg.mode === "login" || cfg.mode === "external") {
    return htmlPage({
      title: "Logged out",
      body: "<h1>Logged out / ログアウトしました</h1><p>You can close this window.<br>このウィンドウを閉じてください。</p>",
      headers: clear,
    });
  }
  const team = env.ACCESS_TEAM_DOMAIN.replace(/\/+$/, "");
  return htmlPage({
    title: "Logged out",
    body:
      "<h1>Logged out / ログアウトしました</h1>" +
      "<p>Access to the protected files has been closed in this browser.<br>このブラウザでの閲覧を終了しました。</p>" +
      `<p><a href="${team}/cdn-cgi/access/logout">Also sign out of Cloudflare Access / Cloudflare Access からもログアウトする</a></p>`,
    headers: clear,
  });
}

/* ---------- AuthAccessTokenService2 ---------- */

type ErrorProfile =
  | "invalidRequest"
  | "invalidOrigin"
  | "missingAspect"
  | "expiredAspect"
  | "invalidAspect"
  | "unavailable";

const ERROR_TEXT: Record<ErrorProfile, [string, string]> = {
  invalidRequest: ["Invalid request", "The token request is missing messageId or origin."],
  invalidOrigin: ["Origin not allowed", "This origin may not request access tokens."],
  missingAspect: ["Login required", "Please log in first."],
  expiredAspect: ["Login expired", "Your login has expired. Please log in again."],
  invalidAspect: ["Invalid login", "Your login is not valid for this collection."],
  unavailable: ["Unavailable", "The service is temporarily unavailable."],
};

const CONTEXT = "http://iiif.io/api/auth/2/context.json";

function tokenPage(message: unknown | null, origin: string | null, allowedOrigins: string[]): Response {
  const ancestors = allowedOrigins.length ? allowedOrigins.join(" ") : "'none'";
  const script =
    message !== null && origin !== null
      ? `window.parent.postMessage(${safeJson(message)}, ${safeJson(origin)});`
      : undefined;
  return htmlPage({
    title: "Token",
    body: "",
    script,
    headers: { "Content-Security-Policy": `frame-ancestors ${ancestors}` },
  });
}

export async function handleToken(
  request: Request,
  env: Env,
  c: string,
  cfg: CollectionConfig,
  now: number,
): Promise<Response> {
  const q = new URL(request.url).searchParams;
  const origin = q.get("origin");
  const messageId = q.get("messageId");

  // The spec only lets us reply to the origin the client declared, and only if
  // we accept it. With any other origin nothing is posted at all.
  if (!origin || !cfg.allowedOrigins.includes(origin)) {
    return tokenPage(null, null, cfg.allowedOrigins);
  }

  const fail = (profile: ErrorProfile) =>
    tokenPage(
      {
        "@context": CONTEXT,
        type: "AuthAccessTokenError2",
        profile,
        heading: { en: [ERROR_TEXT[profile][0]] },
        note: { en: [ERROR_TEXT[profile][1]] },
        messageId: messageId ?? "",
      },
      origin,
      cfg.allowedOrigins,
    );

  if (!messageId) return fail("invalidRequest");

  try {
    const cookie = readCookie(request, `${SESSION_COOKIE_PREFIX}${c}`);
    if (!cookie) return fail("missingAspect");
    const v = await verifyValue(env.SIGNING_KEY, cookie, "session", c, now);
    if (!v.ok) return fail(v.reason === "expired" ? "expiredAspect" : "invalidAspect");

    const accessToken = await signValue(env.SIGNING_KEY, {
      typ: "token",
      c,
      sub: v.payload.sub,
      exp: now + TOKEN_LIFETIME,
    });
    return tokenPage(
      { "@context": CONTEXT, type: "AuthAccessToken2", messageId, accessToken, expiresIn: TOKEN_LIFETIME },
      origin,
      cfg.allowedOrigins,
    );
  } catch (err) {
    console.error("token service error", err instanceof Error ? err.message : String(err));
    return fail("unavailable");
  }
}
