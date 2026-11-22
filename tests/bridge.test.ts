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
      voiceStatus: "ani9:voice-status",
      voiceInstall: "ani9:voice-install",
      voiceListen: "ani9:voice-listen",
      voiceAudio: "ani9:voice-audio",
      voiceStop: "ani9:voice-stop",
      voiceCancel: "ani9:voice-cancel",
      voiceSay: "ani9:voice-say",
      voiceHush: "ani9:voice-hush",
      voiceEvent: "ani9:voice-event",
    });
  });
});

describe("voice", () => {
  it("takes only short pieces of sound and short sentences from the page", async () => {
    const { voiceAudioSchema, voiceSaySchema } = await import("../src/shared/bridge.js");
    expect(voiceAudioSchema.safeParse(new Float32Array(2048)).success).toBe(true);
    expect(voiceAudioSchema.safeParse(new Float32Array(0)).success).toBe(false);
    expect(voiceAudioSchema.safeParse(new Float32Array(40_000)).success).toBe(false);
    expect(voiceAudioSchema.safeParse([0.1, 0.2]).success).toBe(false);
    expect(voiceSaySchema.safeParse([1, "Pronto."]).success).toBe(true);
    expect(voiceSaySchema.safeParse([0, "Pronto."]).success).toBe(false);
    expect(voiceSaySchema.safeParse([2, ""]).success).toBe(false);
  });
});
