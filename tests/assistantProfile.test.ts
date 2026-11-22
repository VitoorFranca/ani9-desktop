import { describe, expect, it } from "vitest";
import {
  engineArgs,
  engineEnv,
  foreignTools,
  readAuthStatus,
  readEngineLine,
  reportedTools,
  toolsConfig,
  userLine,
  generationArgs,
  generationResult,
} from "../src/main/assistantProfile.js";
import { assistantChannelSchema, assistantStartSchema, assistantTextSchema } from "../src/shared/bridge.js";

const TOKEN = `ani9a_${"a".repeat(40)}.${"b".repeat(43)}`;
const start = { systemPrompt: "Você é o tutor.", token: TOKEN, model: "default" as const };

describe("engine profile", () => {
  it("launches Claude Code with no tools of its own, no settings of the person and nothing kept on disk", () => {
    const args = engineArgs(start, "/tmp/f.json");
    const value = (flag: string) => args[args.indexOf(flag) + 1];
    expect(args[0]).toBe("-p");
    expect(value("--tools")).toBe("");
    expect(value("--setting-sources")).toBe("");
    expect(args).toContain("--strict-mcp-config");
    expect(value("--mcp-config")).toBe("/tmp/f.json");
    expect(value("--allowedTools")).toBe("mcp__ani9__*");
    expect(value("--permission-mode")).toBe("dontAsk");
    expect(args).toContain("--no-session-persistence");
    expect(value("--system-prompt")).toBe("Você é o tutor.");
    expect(args).not.toContain("--model");
    // Never the mode that ignores the person's login, nor one that skips permissions.
    expect(args).not.toContain("--bare");
    expect(args.join(" ")).not.toMatch(/dangerously|bypass/i);
    // The token is in the file, not in the command line.
    expect(args.join(" ")).not.toContain(TOKEN);
  });

  it("passes a chosen model and nothing the page could smuggle in", () => {
    expect(engineArgs({ ...start, model: "haiku" }, "f")).toEqual(expect.arrayContaining(["--model", "haiku"]));
    const odd = engineArgs({ ...start, model: "--dangerously-skip-permissions" as never }, "f");
    expect(odd).not.toContain("--model");
    expect(odd).not.toContain("--dangerously-skip-permissions");
  });

  it("points the tools at the ANI-9 itself, with the conversation token", () => {
    const config = JSON.parse(toolsConfig("https://www.ani9.online", TOKEN));
    expect(Object.keys(config.mcpServers)).toEqual(["ani9"]);
    expect(config.mcpServers.ani9).toEqual({
      type: "http",
      url: "https://www.ani9.online/api/assistant/mcp",
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
  });

  it("gives the engine no API key and none of the app's environment", () => {
    const env = engineEnv({
      HOME: "/Users/x",
      USER: "x",
      ANTHROPIC_API_KEY: "sk",
      ANTHROPIC_AUTH_TOKEN: "t",
      SECRET: "s",
    });
    expect(env.HOME).toBe("/Users/x");
    expect(env.CLAUDE_CODE_DISABLE_AUTO_MEMORY).toBe("1");
    expect(Object.keys(env).some((name) => /ANTHROPIC|SECRET/.test(name))).toBe(false);
  });

  it("refuses a conversation whose engine has any tool that is not the ANI-9's", () => {
    expect(foreignTools(["mcp__ani9__roadmaps_listar"])).toEqual([]);
    expect(foreignTools(["mcp__ani9__x", "Bash"])).toEqual(["Bash"]);
    expect(foreignTools(["mcp__outro__x"])).toEqual(["mcp__outro__x"]);
    expect(foreignTools(undefined)).toEqual(["?"]);
    expect(reportedTools(JSON.stringify({ type: "system", subtype: "init", tools: ["Bash"] }))).toEqual(["Bash"]);
    expect(reportedTools(JSON.stringify({ type: "system", subtype: "init" }))).toEqual(["?"]);
    expect(reportedTools(JSON.stringify({ type: "assistant" }))).toBeNull();
  });
});

describe("engine output", () => {
  it("turns the engine's lines into what the page shows", () => {
    expect(
      readEngineLine(
        JSON.stringify({ type: "system", subtype: "init", tools: ["mcp__ani9__a"], apiKeySource: "none", model: "m" }),
      ),
    ).toEqual([{ type: "ready", tools: ["a"], subscription: true, model: "m" }]);
    expect(
      readEngineLine(JSON.stringify({ type: "stream_event", event: { delta: { type: "text_delta", text: "Oi" } } })),
    ).toEqual([{ type: "delta", text: "Oi" }]);
    expect(
      readEngineLine(
        JSON.stringify({
          type: "assistant",
          message: {
            content: [
              { type: "thinking", thinking: "" },
              { type: "tool_use", name: "mcp__ani9__roadmaps_listar", input: {} },
              { type: "text", text: "Pronto." },
            ],
          },
        }),
      ),
    ).toEqual([
      { type: "tool", name: "roadmaps_listar" },
      { type: "message", text: "Pronto." },
    ]);
    expect(readEngineLine(JSON.stringify({ type: "result", subtype: "success", is_error: false }))).toEqual([
      { type: "done", ok: true },
    ]);
    expect(
      readEngineLine(JSON.stringify({ type: "result", subtype: "success", is_error: true, result: "Not logged in" })),
    ).toEqual([{ type: "done", ok: false, error: "Not logged in" }]);
    expect(
      readEngineLine(
        JSON.stringify({
          type: "rate_limit_event",
          rate_limit_info: {
            status: "allowed",
            resetsAt: 10,
            unifiedWindows: { five_hour: { utilization: 0.25 }, seven_day: { utilization: 0.05 } },
          },
        }),
      ),
    ).toEqual([{ type: "usage", status: "allowed", fiveHour: 0.25, sevenDay: 0.05, resetsAt: 10 }]);
    expect(readEngineLine("não é json")).toEqual([]);
    expect(readEngineLine(JSON.stringify({ type: "user" }))).toEqual([]);
  });

  it("tells the page when a tool is called and when it answers, never what it carried", () => {
    expect(
      readEngineLine(
        JSON.stringify({
          type: "assistant",
          message: {
            content: [
              {
                type: "tool_use",
                id: "t1",
                name: "mcp__ani9__plataforma_agir",
                input: { metodo: "POST", caminho: "/api/decks" },
              },
            ],
          },
        }),
      ),
    ).toEqual([{ type: "tool", name: "plataforma_agir", id: "t1" }]);
    expect(
      readEngineLine(
        JSON.stringify({
          type: "user",
          message: {
            role: "user",
            content: [
              { type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: '{"id":"segredo"}' }] },
              { type: "tool_result", tool_use_id: "t2", is_error: true, content: "recusado" },
            ],
          },
        }),
      ),
    ).toEqual([
      { type: "toolDone", ok: true, id: "t1" },
      { type: "toolDone", ok: false, id: "t2" },
    ]);
    // What the person typed comes back as plain text: nothing to tell.
    expect(readEngineLine(JSON.stringify({ type: "user", message: { role: "user", content: "oi" } }))).toEqual([]);
  });

  it("writes one message per line for the engine", () => {
    const line = userLine('diga "oi"\nagora');
    expect(line.endsWith("\n")).toBe(true);
    expect(line.trim().includes("\n")).toBe(false);
    expect(JSON.parse(line)).toEqual({ type: "user", message: { role: "user", content: 'diga "oi"\nagora' } });
  });

  it("makes a piece apart with no tool at all, and reads its answer", () => {
    const args = generationArgs({ system: "Instruções", prompt: "Pêndulo", model: "sonnet" });
    expect(args).toEqual(
      expect.arrayContaining(["--model", "sonnet", "--tools", "", "--strict-mcp-config", "--effort", "low"]),
    );
    expect(args).not.toContain("--mcp-config");
    expect(args).not.toContain("--allowedTools");
    expect(generationResult('{"type":"result","is_error":false,"result":"```html\\n<p>oi</p>\\n```"}')).toEqual({
      ok: true,
      text: "```html\n<p>oi</p>\n```",
    });
    expect(generationResult('{"is_error":true,"result":"erro"}').ok).toBe(false);
    expect(generationResult("lixo").ok).toBe(false);
  });

  it("sends files the engine reads itself, named, before what the person wrote", () => {
    const line = userLine("resume", [
      { name: "aula.pdf", mediaType: "application/pdf", data: "JVBERi0=" },
      { name: "quadro.png", mediaType: "image/png", data: "iVBORw==" },
    ]);
    expect(line.trim().includes("\n")).toBe(false);
    const content = JSON.parse(line).message.content;
    expect(content.map((part: { type: string }) => part.type)).toEqual(["text", "document", "text", "image", "text"]);
    expect(content[1]).toMatchObject({
      source: { media_type: "application/pdf", data: "JVBERi0=" },
      title: "aula.pdf",
    });
    expect(content.at(-1)).toEqual({ type: "text", text: "resume" });
  });

  it("reads who is signed in to Claude Code", () => {
    const now = new Date("2026-11-18T00:00:00Z");
    const signed = { loggedIn: true, subscriptionType: "max", loginExpiresAt: "2026-12-03T20:24:24.269Z" };
    expect(readAuthStatus(JSON.stringify(signed), now)).toEqual({
      state: "ready",
      plan: "max",
      loginExpiresAt: signed.loginExpiresAt,
    });
    expect(readAuthStatus(JSON.stringify(signed), new Date("2026-12-04T00:00:00Z")).state).toBe("expired");
    expect(readAuthStatus(JSON.stringify({ loggedIn: false }), now).state).toBe("logged-out");
    expect(readAuthStatus("Not logged in", now).state).toBe("logged-out");
  });
});

describe("what the page may send", () => {
  it("accepts a start with the server's token and refuses anything else", () => {
    expect(assistantStartSchema.safeParse(start).success).toBe(true);
    expect(assistantStartSchema.safeParse({ ...start, token: "ani9_abc" }).success).toBe(false);
    expect(assistantStartSchema.safeParse({ ...start, token: `${TOKEN}" --x` }).success).toBe(false);
    expect(assistantStartSchema.safeParse({ ...start, model: "gpt" }).success).toBe(false);
    expect(assistantStartSchema.safeParse({ ...start, executable: "/bin/sh" }).success).toBe(false);
    expect(assistantStartSchema.safeParse({ ...start, mcpUrl: "https://evil.com" }).success).toBe(false);
    expect(assistantTextSchema.safeParse("").success).toBe(false);
    expect(assistantTextSchema.safeParse("x".repeat(200_001)).success).toBe(false);
  });

  it("takes a channel only as a plain name of one of the page's conversations", () => {
    expect(assistantStartSchema.safeParse({ ...start, channel: "chat" }).success).toBe(true);
    expect(assistantChannelSchema.safeParse("assistente").success).toBe(true);
    for (const odd of ["", "../x", "a b", "A", "x".repeat(41), 3, {}]) {
      expect(assistantChannelSchema.safeParse(odd).success, String(odd)).toBe(false);
    }
  });
});
