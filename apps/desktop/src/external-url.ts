const EXTERNAL_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);

/**
 * Where a navigation goes: `app` stays in the window, `external` opens in the
 * default browser or mail client, `deny` is dropped.
 */
export function routeUrl(url: string, appOrigin: string): "app" | "external" | "deny" {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "deny";
  }
  if (parsed.origin === appOrigin) return "app";
  return EXTERNAL_PROTOCOLS.has(parsed.protocol) ? "external" : "deny";
}
