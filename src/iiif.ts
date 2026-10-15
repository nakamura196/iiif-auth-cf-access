import type { CollectionConfig, LanguageMap } from "./types.ts";

const DEFAULT_LOGOUT_LABEL: LanguageMap = { en: ["Log out"], ja: ["ログアウト"] };

export function encodePath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

/**
 * IIIF Auth 2.0 service block to put in the `service` property of a content
 * resource (e.g. a Model body in a Presentation 3 manifest).
 *
 * Nesting follows https://iiif.io/api/auth/2.0/ : the probe service lists the
 * access service(s); the access service lists exactly one token service and
 * optionally a logout service.
 */
export function serviceBlock(base: string, collection: string, path: string, config: CollectionConfig) {
  const root = base.replace(/\/+$/, "");
  const c = encodeURIComponent(collection);
  return {
    id: `${root}/probe/${c}/${encodePath(path)}`,
    type: "AuthProbeService2",
    service: [
      {
        id: `${root}/auth/login/${c}`,
        type: "AuthAccessService2",
        profile: "active",
        label: config.label,
        heading: config.heading,
        note: config.note,
        confirmLabel: config.confirmLabel,
        service: [
          { id: `${root}/auth/token/${c}`, type: "AuthAccessTokenService2" },
          {
            id: `${root}/auth/logout/${c}`,
            type: "AuthLogoutService2",
            label: config.logoutLabel ?? DEFAULT_LOGOUT_LABEL,
          },
        ],
      },
    ],
  };
}
