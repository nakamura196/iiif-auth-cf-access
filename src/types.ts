/** IIIF language map: { "en": ["..."], "ja": ["..."] } */
export type LanguageMap = Record<string, string[]>;

export interface CollectionConfig {
  /**
   * "access" (default): /auth/login/<c> is guarded by Cloudflare Access and needs its JWT.
   * "clickthrough": no login at all. Opening /auth/login/<c> is the user's agreement
   * (a content advisory); it sets the session cookie straight away.
   * "login": a form asking for `demoUser` / `demoPassword`, opened by the viewer in a popup
   * (profile "active"). "external": the same form, but the user opens it first, in an ordinary
   * tab; the viewer opens nothing and only asks the token service (profile "external").
   */
  mode?: "access" | "clickthrough" | "login" | "external";
  /**
   * Credentials of the "login" and "external" modes. They are DELIBERATELY PUBLIC: the demo
   * page shows them, so the flow can be tried. Never put a real secret here. Both are
   * required; without them the login page fails closed.
   */
  demoUser?: string;
  demoPassword?: string;
  /** AUD tag of the Cloudflare Access application guarding /auth/login/<c>. Unused for "clickthrough". */
  aud?: string;
  /** Origins of the IIIF clients allowed to use the token service. */
  allowedOrigins: string[];
  label: LanguageMap;
  heading: LanguageMap;
  note: LanguageMap;
  confirmLabel: LanguageMap;
  /** Optional label of the logout service. */
  logoutLabel?: LanguageMap;
  /** Session cookie lifetime in seconds. */
  cookieMaxAge: number;
  /**
   * Degraded access: users who have not been let in see a public, degraded copy of each
   * image (the image "<id>-degraded"). The probe answers 401 with it as `substitute`.
   * This is the copy's label.
   */
  substituteLabel?: LanguageMap;
}

export interface Env {
  ACCESS_TEAM_DOMAIN: string;
  /** JSON object (wrangler var object) or a JSON string. */
  COLLECTIONS: Record<string, CollectionConfig> | string;
  SIGNING_KEY: string;
  /** Private R2 bucket with keys "<collection>/<path>". Use this or ASSETS. */
  FILES?: R2Bucket;
  /** Workers Static Assets (run_worker_first: true) laid out as "<collection>/<path>". */
  ASSETS?: Fetcher;
  /** Entries of the showcase's top page. Without it, "/" is 404. */
  DEMOS?: Demo[] | string;
}

/** One entry of the showcase's top page: an image or a 3D model of a collection. */
export interface Demo {
  /** Short name of the pattern, e.g. "clickthrough". */
  type: string;
  collection: string;
  /** Image id under "<collection>/image/". Give this or `model`. */
  image?: string;
  /** Model id under "<collection>/model/". */
  model?: string;
  title: LanguageMap;
  description: LanguageMap;
}

export type SignedType = "session" | "token";

export interface SignedPayload {
  typ: SignedType;
  c: string;
  sub: string;
  exp: number;
}
