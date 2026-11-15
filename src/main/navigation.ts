// Which addresses the window may show. Only the ANI-9 itself opens inside the
// app; links to other sites go to the default browser; anything else is
// blocked. Kept free of Electron so it can be tested on its own.

export const DEFAULT_APP_URL = "https://www.ani9.online/";

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

/**
 * The address the window opens: the ANI-9 in production, or another one given
 * in ANI9_DESKTOP_URL for development (https, or http on this machine only).
 */
export function resolveAppUrl(override: string | undefined): URL {
  if (!override) return new URL(DEFAULT_APP_URL);
  let url: URL;
  try {
    url = new URL(override);
  } catch {
    throw new Error(`ANI9_DESKTOP_URL inválida: ${override}`);
  }
  const local = url.protocol === "http:" && LOOPBACK.has(url.hostname);
  if (url.protocol !== "https:" && !local) {
    throw new Error("ANI9_DESKTOP_URL precisa ser https, ou http só neste computador (127.0.0.1 ou localhost).");
  }
  return new URL(url.origin + "/");
}

/** Whether `url` belongs to the app (same origin as `appOrigin`). */
export function isAppUrl(url: string, appOrigin: string): boolean {
  try {
    return new URL(url).origin === appOrigin;
  } catch {
    return false;
  }
}

/** What to do with a link that leaves the app: the browser opens web and e-mail links; the rest is blocked. */
export function externalAction(url: string): "open" | "block" {
  try {
    const { protocol } = new URL(url);
    return protocol === "https:" || protocol === "http:" || protocol === "mailto:" ? "open" : "block";
  } catch {
    return "block";
  }
}

/** A path inside the app ("/rotina?x=1") turned into a full address of the app. */
export function appPathUrl(path: string, appOrigin: string): string | null {
  if (!/^\/(?![/\\])/.test(path)) return null;
  const url = new URL(path, appOrigin);
  return url.origin === appOrigin ? url.href : null;
}
