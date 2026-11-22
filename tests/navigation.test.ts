import { describe, expect, it } from "vitest";
import {
  DEFAULT_APP_URL,
  appPathUrl,
  externalAction,
  isAppUrl,
  profileFolder,
  resolveAppUrl,
} from "../src/main/navigation.js";

const ORIGIN = "https://www.ani9.online";

describe("resolveAppUrl", () => {
  it("opens the ANI-9 by default", () => {
    expect(resolveAppUrl(undefined).href).toBe(DEFAULT_APP_URL);
    expect(resolveAppUrl("").origin).toBe(ORIGIN);
  });

  it("accepts https and http on this machine, reduced to the origin", () => {
    expect(resolveAppUrl("http://127.0.0.1:4320/decks").href).toBe("http://127.0.0.1:4320/");
    expect(resolveAppUrl("http://localhost:4320").origin).toBe("http://localhost:4320");
    expect(resolveAppUrl("https://preview.example.com/x").href).toBe("https://preview.example.com/");
  });

  it("refuses plain http elsewhere and other schemes", () => {
    expect(() => resolveAppUrl("http://example.com")).toThrow(/https/);
    expect(() => resolveAppUrl("file:///etc/passwd")).toThrow();
    expect(() => resolveAppUrl("javascript:alert(1)")).toThrow();
    expect(() => resolveAppUrl("não é endereço")).toThrow(/inválida/);
  });
});

describe("isAppUrl", () => {
  it("only the app's own origin stays in the window", () => {
    expect(isAppUrl("https://www.ani9.online/rotina?x=1", ORIGIN)).toBe(true);
    expect(isAppUrl("https://ani9.online/", ORIGIN)).toBe(false);
    expect(isAppUrl("http://www.ani9.online/", ORIGIN)).toBe(false);
    expect(isAppUrl("https://www.ani9.online.evil.com/", ORIGIN)).toBe(false);
    expect(isAppUrl("https://evil.com/?https://www.ani9.online", ORIGIN)).toBe(false);
    expect(isAppUrl("https://www.ani9.online@evil.com/", ORIGIN)).toBe(false);
    expect(isAppUrl("https://ani9-api.fly.dev/api/import", ORIGIN)).toBe(false);
    expect(isAppUrl("file:///Users/x/offline.html", ORIGIN)).toBe(false);
    expect(isAppUrl("data:text/html,oi", ORIGIN)).toBe(false);
    expect(isAppUrl("", ORIGIN)).toBe(false);
  });
});

describe("externalAction", () => {
  it("opens web and e-mail links in the browser, blocks the rest", () => {
    expect(externalAction("https://go.dev/doc")).toBe("open");
    expect(externalAction("http://example.com")).toBe("open");
    expect(externalAction("mailto:alguem@example.com")).toBe("open");
    expect(externalAction("file:///Applications/Calculator.app")).toBe("block");
    expect(externalAction("smb://server/share")).toBe("block");
    expect(externalAction("javascript:alert(1)")).toBe("block");
    expect(externalAction("vscode://file/x")).toBe("block");
    expect(externalAction("nada")).toBe("block");
  });
});

describe("appPathUrl", () => {
  it("turns a path of the app into its full address", () => {
    expect(appPathUrl("/rotina", ORIGIN)).toBe("https://www.ani9.online/rotina");
    expect(appPathUrl("/decks/1/study?x=1", ORIGIN)).toBe("https://www.ani9.online/decks/1/study?x=1");
  });

  it("never leaves the app", () => {
    expect(appPathUrl("//evil.com", ORIGIN)).toBeNull();
    expect(appPathUrl("/\\evil.com", ORIGIN)).toBeNull();
    expect(appPathUrl("https://evil.com", ORIGIN)).toBeNull();
    expect(appPathUrl("rotina", ORIGIN)).toBeNull();
  });
});

describe("profileFolder", () => {
  it("keeps the installed app in its own folder, and development apart from it", () => {
    expect(profileFolder("ANI-9", undefined, undefined)).toBe("ANI-9");
    expect(profileFolder("ANI-9", undefined, "teste")).toBe("ANI-9");
    expect(profileFolder("ANI-9", "http://127.0.0.1:4320", undefined)).toBe("ANI-9 Dev");
    expect(profileFolder("ANI-9", "http://127.0.0.1:4320", "teste")).toBe("ANI-9 Dev teste");
    expect(profileFolder("ANI-9", "http://127.0.0.1:4320", "../../x y")).toBe("ANI-9 Dev xy");
  });
});
