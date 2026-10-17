import type { CollectionConfig, Env } from "./types.ts";

export const SESSION_COOKIE_PREFIX = "iiifcf_";
export const TOKEN_LIFETIME = 300;
/** Id suffix of the public, degraded copy of an image (see CollectionConfig.substituteLabel). */
export const DEGRADED_SUFFIX = "-degraded";
/**
 * Signed file URLs expire on the hour, so every probe within the same hour
 * returns the same URL and the browser can reuse its cached copy. A URL is
 * never handed out with less than FILE_URL_MIN_LEFT seconds to run, so it
 * lives between 5 minutes and 1 hour 5 minutes.
 */
export const FILE_URL_BUCKET = 3600;
export const FILE_URL_MIN_LEFT = 300;

export function fileUrlExpiry(now: number): number {
  let exp = Math.ceil(now / FILE_URL_BUCKET) * FILE_URL_BUCKET;
  if (exp - now < FILE_URL_MIN_LEFT) exp += FILE_URL_BUCKET;
  return exp;
}

export function parseCollections(env: Env): Record<string, CollectionConfig> {
  const raw = env.COLLECTIONS;
  return typeof raw === "string" ? (JSON.parse(raw) as Record<string, CollectionConfig>) : raw;
}

/** A path is usable only if every segment is a real name (no "", ".", ".."). */
export function validPath(segs: (string | null)[]): segs is string[] {
  return (
    segs.length > 0 &&
    segs.every((s) => s !== null && s !== "" && s !== "." && s !== ".." && !s.includes("\\") && !s.includes("\0"))
  );
}
