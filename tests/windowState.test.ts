import { describe, expect, it } from "vitest";
import { DEFAULT_SIZE, MIN_SIZE, sanitizeState } from "../src/main/windowState.js";

const SCREEN = [{ x: 0, y: 25, width: 1512, height: 920 }];

describe("sanitizeState", () => {
  it("keeps a window that is still on screen", () => {
    expect(sanitizeState({ bounds: { x: 100, y: 60, width: 1200, height: 800 }, maximized: true }, SCREEN)).toEqual({
      bounds: { x: 100, y: 60, width: 1200, height: 800 },
      maximized: true,
    });
  });

  it("drops the position of a window left on a monitor that is gone", () => {
    expect(sanitizeState({ bounds: { x: 2500, y: 100, width: 1200, height: 800 } }, SCREEN)).toEqual({
      bounds: { width: 1200, height: 800 },
      maximized: false,
    });
  });

  it("uses the default size when nothing usable was saved, and never goes below the minimum", () => {
    expect(sanitizeState(null, SCREEN)).toEqual({ bounds: DEFAULT_SIZE, maximized: false });
    expect(sanitizeState({ bounds: { width: "x" } }, SCREEN)).toEqual({ bounds: DEFAULT_SIZE, maximized: false });
    expect(sanitizeState({ bounds: { width: 10, height: 10 } }, SCREEN).bounds).toEqual(MIN_SIZE);
  });
});
