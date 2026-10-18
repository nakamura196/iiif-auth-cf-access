# iiif-auth-cf-access

A Cloudflare Worker that connects [Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/policies/access/)
to the [IIIF Authorization Flow API 2.0](https://iiif.io/api/auth/2.0/).
Access decides who may log in. The Worker speaks IIIF Auth 2.0 to the viewer and serves files from a private R2 bucket or from Workers Static Assets.

- No runtime dependencies. JWT verification and HMAC use WebCrypto only.
- No database. Session cookies, access tokens and file URLs are self-contained HMAC-signed values.
- Targets single-file resources (3D models, PDF, audio, video, image files). The IIIF Image API is not covered.

## How it works

1. The viewer reads the manifest. A content resource carries an `AuthProbeService2`.
2. The viewer calls the probe with no token and gets `status: 401` plus the login description.
3. The user clicks the button. The viewer opens `/auth/login/<c>` in a new window.
   **Cloudflare Access guards only this path.** After login Access forwards the request with a
   `Cf-Access-Jwt-Assertion` header. The Worker verifies it (team JWKS, `aud`, `iss`, `exp`),
   sets its own session cookie `iiifcf_<c>` and closes the window.
4. The viewer loads `/auth/token/<c>` in a hidden iframe. The Worker checks the cookie and
   `postMessage`s a 5-minute access token to the viewer's origin.
5. The viewer calls the probe with `Authorization: Bearer <token>`. The probe answers
   `status: 302` with a `location` holding a signed `/files/...` URL (valid 5 minutes).
6. The viewer fetches the file from that URL. **The file request needs no cookie.**

Everything except the login path is reachable without Access, so cross-origin `fetch` from a viewer is not
redirected to an Access login page (which would fail on CORS).

## Endpoints

`<c>` must be a key of `COLLECTIONS`, otherwise 404. Everything else is 404.

| Path | IIIF service | Access | Notes |
|---|---|---|---|
| `GET /auth/login/<c>` | AuthAccessService2 (`active`) | **yes** | Verifies the Access JWT, sets cookie `iiifcf_<c>`, closes the window. 403 on failure. |
| `GET /auth/token/<c>?messageId=&origin=` | AuthAccessTokenService2 | no | HTML that posts `AuthAccessToken2` or `AuthAccessTokenError2` to `origin`. Only origins in `allowedOrigins`; others get a page with no message. `frame-ancestors` is set to `allowedOrigins`. |
| `GET /probe/<c>/<path>` (+ `OPTIONS`) | AuthProbeService2 | no | Always HTTP 200. `status` 302 (+`location`), 401 (+`heading`, `note`) or 404. CORS `*`. |
| `GET/HEAD /files/<c>/<path>?exp=&sig=` | the resource itself | no | HMAC-signed, 5 minutes. Range supported. CORS `*`. |
| `GET /auth/logout/<c>` | AuthLogoutService2 | no | Clears the cookie and links to `/cdn-cgi/access/logout`. |
| `GET /image/<c>/<id>/info.json` | IIIF Image API 3 (level 0) | no | Public. `id` and the auth services are filled in for the requesting host. CORS `*`. |
| `GET /image/<c>/<id>/<tile>` | image tiles | no | Need the cookie `iiifcf_<c>` (tiles are loaded by `<img>`, which cannot send a token). 401 otherwise. |
| `GET /manifest/<c>/<id>.json` | Presentation 3 | no | One canvas around the image service, from `meta.json`. |
| `GET /` | | no | Top page listing `DEMOS`. 404 when `DEMOS` is not set. |

For an image service (`/probe/<c>/image/<id>/info.json`) the probe answers `status` 200 without a `location`:
the client then loads the tiles, which carry the cookie.

Degraded access: in a collection with `substituteLabel`, the image `<id>-degraded` is a public copy (no auth
services, tiles without a cookie). Without a good token, the probe of `<id>` answers `status` 401 with
`substitute: [{ id: <the copy's service id>, type: "ImageService3", ... }]`; the client shows the copy and
still offers the access service. (`location` is for 30x only: "load this instead", e.g. a signed URL.)
The same works for a 3D model `<c>/model/<id>/model.glb`: `<id>-degraded/model.glb` (e.g. a lighter point
cloud) is served from `/files` without a signature and offered as `substitute: [{ id, type: "Model", ... }]`;
once the token is good, the probe answers 302 with a signed URL of the full model.

Signed values are `base64url(JSON) "." base64url(HMAC-SHA256)`. The payload has `typ` (`session` or `token`),
`c` (collection), `sub` (email) and `exp`. A token is never accepted as a session, a session never as a token,
and neither across collections. The token is a different string from the cookie, as the spec requires.

File keys are `<collection>/<path>`, for example `railclass/icet_411.glb` or `railclass/downloads/icet_411.stl`.
Images are `<collection>/image/<id>/` with `info.json`, `meta.json` and the tiles of `vips dzsave --layout iiif3`;
`scripts/build-demo-assets.zsh` makes them from `demo/images.json` (`"degraded": <px>` adds the greyscale `<id>-degraded`).
Models are `<collection>/model/<id>/` with `model.glb` and `meta.json`, made from `demo/models.json`
(`"degraded": <url>` adds `<id>-degraded/model.glb`). `/manifest/<c>/<id>.json` builds a Presentation 4
manifest with one Scene for a model.

## Configuration

`wrangler.jsonc`:

| Name | Kind | Meaning |
|---|---|---|
| `ACCESS_TEAM_DOMAIN` | var | `https://<team>.cloudflareaccess.com`, no trailing slash. JWKS is read from `/cdn-cgi/access/certs` (cached 10 minutes). |
| `COLLECTIONS` | var (object) | One entry per collection (below). |
| `DEMOS` | var (array, optional) | Entries of the top page: `type`, `collection`, `image`, `title`, `description`. |
| `SIGNING_KEY` | secret | HMAC key, at least 32 characters (the Worker answers 500 otherwise). |
| `FILES` | R2 binding | Private bucket. Use this or `ASSETS`. |
| `ASSETS` | static assets binding | Files deployed with the Worker. Needs `run_worker_first: true`. |

Collection entry: optional `mode` (`access`, the default, or `clickthrough`: no login, opening the access service is the agreement; `login`: a form with a demo ID and password, opened by the viewer in a popup; `external`: the same form, opened by the user first in an ordinary tab, and the access service has profile `external` with no `id`, so the viewer only asks the token service), `demoUser` / `demoPassword` (required for `login` and `external`; deliberately public, shown on the form, never a real secret), `aud` (Access application AUD tag, only for `access`), `allowedOrigins` (viewer origins), `label`, `heading`, `note`,
`confirmLabel` (IIIF language maps), optional `logoutLabel`, `cookieMaxAge` (seconds), optional `substituteLabel`
(turns on degraded access, above).

`workers_dev` and `preview_urls` are `false` on purpose: a `*.workers.dev` URL would not be behind Access.

Set the secret without putting it on disk or in shell history:

```
op read "op://Personal/<item>/signing_key" | npx wrangler secret put SIGNING_KEY
```

Local development: copy `.dev.vars.example` to `.dev.vars` (git-ignored) and fill it from 1Password, then `npm run dev`.
Locally there is no Access in front, so `/auth/login/<c>` returns 403 unless you send a valid JWT yourself.

## Cloudflare setup

1. Choose where the files live.
   - **Workers Static Assets** (no R2 needed, free plan): files are uploaded with each deploy.
     Limits: 25 MiB per file, 20,000 files. `run_worker_first: true` is required, otherwise the files would be
     served to anyone. See `deploy/railclass.jsonc` and `scripts/deploy.zsh`.
   - **R2**: create a private bucket, upload files under `<collection>/<path>`, put its name in `r2_buckets`.
     R2 has to be enabled on the account first.
2. Zero Trust: add a self-hosted Access application.
   - Hostname: your Worker's host (for example `models.railclass.ldas.jp`), path `/auth/login/<collection>`.
   - Policy: Allow, include an email list (one-time PIN is enough).
   - Copy the application's **AUD tag** into `COLLECTIONS.<collection>.aud`.
   - Use one application per collection if the collections have different audiences.
3. Set `ACCESS_TEAM_DOMAIN`, `allowedOrigins`, and the texts. Uncomment and edit `routes` for the custom domain.
4. Set the `SIGNING_KEY` secret (above), then `npx wrangler deploy`.
5. Keep `workers_dev: false` and `preview_urls: false`.

## Manifest example

Put the output of `serviceBlock()` in the `service` property of the content resource:

```json
{
  "id": "https://models.example.org/files/railclass/icet_411.glb",
  "type": "Model",
  "format": "model/gltf-binary",
  "service": [
    {
      "id": "https://models.example.org/probe/railclass/icet_411.glb",
      "type": "AuthProbeService2",
      "service": [
        {
          "id": "https://models.example.org/auth/login/railclass",
          "type": "AuthAccessService2",
          "profile": "active",
          "label": { "en": ["Log in to RailClass"] },
          "heading": { "en": ["Please log in"] },
          "note": { "en": ["Approved users only."] },
          "confirmLabel": { "en": ["Log in"] },
          "service": [
            { "id": "https://models.example.org/auth/token/railclass", "type": "AuthAccessTokenService2" },
            {
              "id": "https://models.example.org/auth/logout/railclass",
              "type": "AuthLogoutService2",
              "label": { "en": ["Log out"] }
            }
          ]
        }
      ]
    }
  ]
}
```

The body `id` is a placeholder: the viewer asks the probe first and then fetches the `location` it returns.

Generate it from TypeScript (`import { serviceBlock } from "./src/iiif.ts"`) or from the command line
(Node 22.18 or later; `collection.json` is one collection's entry from `COLLECTIONS` as plain JSON):

```
node scripts/service-block.mjs https://models.example.org railclass icet_411.glb collection.json
```

From a static-site build in another language, emit the same structure. Python:

```python
def service_block(base, c, path, cfg):
    return {
        "id": f"{base}/probe/{c}/{path}",
        "type": "AuthProbeService2",
        "service": [{
            "id": f"{base}/auth/login/{c}", "type": "AuthAccessService2", "profile": "active",
            "label": cfg["label"], "heading": cfg["heading"], "note": cfg["note"],
            "confirmLabel": cfg["confirmLabel"],
            "service": [
                {"id": f"{base}/auth/token/{c}", "type": "AuthAccessTokenService2"},
                {"id": f"{base}/auth/logout/{c}", "type": "AuthLogoutService2",
                 "label": {"en": ["Log out"]}},
            ],
        }],
    }
```

## Limitations

- The token iframe still needs the session cookie. It works when the viewer and the Worker are same-site
  (for example both under `ldas.jp`). A viewer on another site may fail in browsers that block third-party cookies
  (Safari, and Chrome with third-party cookie blocking). The spec describes the same constraint (Appendix A).
- Returning a signed URL in the probe's `location` is not shown in the spec, which assumes cookies for the resource.
  It fits the definition of `location` (the resource the client should request instead).
- The IIIF Image API (many tiles) is not covered.
- Signed file URLs expire on the hour (at least 5 minutes, at most 1 hour 5 minutes), so repeat views in the same hour
  hit the browser cache. Anyone who has such a URL can use it until then.
- Access tokens are not revocable before they expire (5 minutes). A session cookie lasts `cookieMaxAge` (1 hour in the example; when it runs out the login window
  opens and closes by itself while the Access session lasts);
  removing someone from the Access policy stops new logins, not an existing cookie.
- If the token service gets an `origin` that is not allowed, it posts nothing (the spec has no safe target for the error).

## Development

```
npm ci
npm test          # vitest in the Workers runtime (miniflare, R2 in memory, fake Access JWKS)
npm run typecheck
npm run dev
```

`package.json` has `overrides` for `sharp` and `undici` to clear `npm audit` findings in wrangler/miniflare's
transitive dependencies. Remove them when the upstream packages catch up.

## License

MIT
