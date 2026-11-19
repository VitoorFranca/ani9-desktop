import { describe, expect, it } from "vitest";
import { BRIDGE_VERSION, CHANNELS, badgeSchema, badgeText, noticeSchema } from "../src/shared/bridge.js";

describe("noticeSchema", () => {
  it("accepts a reminder from the page", () => {
    const notice = { tag: "ani9-tarefa-1", title: "Revisar", body: "08:00", url: "/rotina", taskId: "t1" };
    expect(noticeSchema.parse(notice)).toEqual(notice);
    expect(noticeSchema.parse({ tag: "foco", title: "Pausa" })).toEqual({ tag: "foco", title: "Pausa" });
  });

  it("refuses screens outside the app and broken notices", () => {
    expect(noticeSchema.safeParse({ tag: "x", title: "y", url: "https://evil.com" }).success).toBe(false);
    expect(noticeSchema.safeParse({ tag: "x", title: "y", url: "//evil.com" }).success).toBe(false);
    expect(noticeSchema.safeParse({ tag: "x", title: "y", url: "/\\evil.com" }).success).toBe(false);
    expect(noticeSchema.safeParse({ tag: "", title: "y" }).success).toBe(false);
    expect(noticeSchema.safeParse({ tag: "x", title: "y".repeat(201) }).success).toBe(false);
    expect(noticeSchema.safeParse({ tag: "x", title: "y", link: "https://evil.com" }).data).not.toHaveProperty("link");
    expect(noticeSchema.safeParse("texto").success).toBe(false);
  });
});

describe("badge", () => {
  it("accepts whole counts and writes them for the Dock", () => {
    expect(badgeSchema.safeParse(12).success).toBe(true);
    expect(badgeSchema.safeParse(-1).success).toBe(false);
    expect(badgeSchema.safeParse(1.5).success).toBe(false);
    expect(badgeSchema.safeParse("3").success).toBe(false);
    expect(badgeText(0)).toBe("");
    expect(badgeText(42)).toBe("42");
    expect(badgeText(12000)).toBe("9999+");
  });
});

describe("contract", () => {
  it("keeps the version and channel names the web client relies on", () => {
    expect(BRIDGE_VERSION).toBe(1);
    expect(CHANNELS).toEqual({
      notify: "ani9:notify",
      setBadge: "ani9:set-badge",
      navigate: "ani9:navigate",
      taskDone: "ani9:task-done",
      listening: "ani9:listening",
      assistantStatus: "ani9:assistant-status",
      assistantStart: "ani9:assistant-start",
      assistantSend: "ani9:assistant-send",
      assistantInterrupt: "ani9:assistant-interrupt",
      assistantStop: "ani9:assistant-stop",
      assistantEvent: "ani9:assistant-event",
    });
  });
});
