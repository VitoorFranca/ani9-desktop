import { describe, expect, it } from "vitest";
import { checkForUpdate, isNewer, latestRelease, parseVersion } from "../src/main/updates.js";

const reply =
  (status: number, body: unknown = {}) =>
  async () => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const release = (tag: string, url = `https://github.com/VitoorFranca/ani9-desktop/releases/tag/${tag}`) =>
  reply(200, { tag_name: tag, html_url: url });

describe("versions", () => {
  it("compares major, minor and patch as numbers", () => {
    expect(parseVersion("v1.2.3")).toEqual([1, 2, 3]);
    expect(parseVersion("1.2")).toBeNull();
    expect(isNewer("0.1.1", "0.1.0")).toBe(true);
    expect(isNewer("v0.10.0", "0.9.9")).toBe(true);
    expect(isNewer("1.0.0", "0.99.99")).toBe(true);
    expect(isNewer("0.1.0", "0.1.0")).toBe(false);
    expect(isNewer("0.0.9", "0.1.0")).toBe(false);
    expect(isNewer("lixo", "0.1.0")).toBe(false);
  });
});

describe("latestRelease", () => {
  it("reads the latest release of this repository", async () => {
    expect(await latestRelease(release("v0.2.0"))).toEqual({
      version: "0.2.0",
      url: "https://github.com/VitoorFranca/ani9-desktop/releases/tag/v0.2.0",
    });
  });

  it("no release yet, or a page outside the repository: nothing to offer", async () => {
    expect(await latestRelease(reply(404))).toBeNull();
    expect(await latestRelease(release("v9.9.9", "https://evil.com/ani9.dmg"))).toBeNull();
    expect(await latestRelease(release("nightly"))).toBeNull();
  });

  it("GitHub unreachable: an error the menu can report", async () => {
    await expect(latestRelease(reply(503))).rejects.toThrow(/503/);
  });
});

describe("checkForUpdate", () => {
  it("offers only a newer version", async () => {
    expect(await checkForUpdate("0.1.0", release("v0.1.1"))).toMatchObject({ version: "0.1.1" });
    expect(await checkForUpdate("0.1.1", release("v0.1.1"))).toBeNull();
  });
});
