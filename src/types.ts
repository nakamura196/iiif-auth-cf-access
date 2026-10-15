/** IIIF language map: { "en": ["..."], "ja": ["..."] } */
export type LanguageMap = Record<string, string[]>;

export interface CollectionConfig {
  /** AUD tag of the Cloudflare Access application guarding /auth/login/<c>. */
  aud: string;
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
}

export type SignedType = "session" | "token";

export interface SignedPayload {
  typ: SignedType;
  c: string;
  sub: string;
  exp: number;
}
