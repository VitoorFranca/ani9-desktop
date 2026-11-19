// How the Assistente's engine is launched: the Claude Code the person
// installed, unmodified, signed in with their own account, and locked down
// so the only thing it can touch is the ANI-9's own tools. Everything here is
// decided by the app; the page chooses only the tutor's text, the
// conversation token and the model. Kept free of Electron to be tested alone.

import { ASSISTANT_MODELS, type AssistantEvent, type AssistantStart } from "../shared/bridge-constants.js";

/** The name the ANI-9 tools get inside Claude Code: `mcp__ani9__<tool>`. */
export const TOOL_SERVER = "ani9";
export const TOOL_PREFIX = `mcp__${TOOL_SERVER}__`;
export const ASSISTANT_MCP_PATH = "/api/assistant/mcp";

/** Where Claude Code's installers put it (an app opened from the Finder has no shell PATH). */
export function claudeCandidates(home: string): string[] {
  return [`${home}/.local/bin/claude`, "/opt/homebrew/bin/claude", "/usr/local/bin/claude"];
}

/** The tools file given to Claude Code: one server, the ANI-9 itself, with the conversation's token. */
export function toolsConfig(appOrigin: string, token: string): string {
  return JSON.stringify({
    mcpServers: {
      [TOOL_SERVER]: {
        type: "http",
        url: new URL(ASSISTANT_MCP_PATH, appOrigin).href,
        headers: { Authorization: `Bearer ${token}` },
      },
    },
  });
}

/**
 * Arguments of `claude` for one conversation. No tool of Claude Code's own
 * (no shell, files or web), none of the person's settings, skills, memory or
 * connectors, nothing kept on disk, and whatever is not allowed is refused
 * without asking.
 */
export function engineArgs(config: AssistantStart, toolsFile: string): string[] {
  const model = ASSISTANT_MODELS.includes(config.model) && config.model !== "default" ? ["--model", config.model] : [];
  return [
    "-p",
    ...model,
    "--system-prompt",
    config.systemPrompt,
    "--tools",
    "",
    "--setting-sources",
    "",
    "--strict-mcp-config",
    "--mcp-config",
    toolsFile,
    "--allowedTools",
    `${TOOL_PREFIX}*`,
    "--permission-mode",
    "dontAsk",
    "--no-session-persistence",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
  ];
}

/** The engine's environment: no API key (so the person's plan is used) and nothing else of the app's own. */
export function engineEnv(source: NodeJS.ProcessEnv): Record<string, string> {
  const env: Record<string, string> = {
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
  };
  for (const name of ["HOME", "USER", "LOGNAME", "TMPDIR", "LANG"]) {
    const value = source[name];
    if (value) env[name] = value;
  }
  return env;
}

/** A line the page sends becomes one user message on the engine's input. */
export function userLine(text: string): string {
  return `${JSON.stringify({ type: "user", message: { role: "user", content: text } })}\n`;
}

/** Tools the engine reports that are not the ANI-9's: with any of these, the conversation must not go on. */
export function foreignTools(tools: unknown): string[] {
  if (!Array.isArray(tools)) return ["?"];
  return tools.filter((tool): tool is string => typeof tool !== "string" || !tool.startsWith(TOOL_PREFIX)).map(String);
}

type Json = Record<string, unknown>;
const obj = (value: unknown): Json | null => (value && typeof value === "object" ? (value as Json) : null);

/** The tools the engine says it has, when the line is its opening report; null for any other line. */
export function reportedTools(line: string): unknown[] | null {
  try {
    const message = obj(JSON.parse(line));
    if (message?.type !== "system" || message.subtype !== "init") return null;
    return Array.isArray(message.tools) ? message.tools : ["?"];
  } catch {
    return null;
  }
}
const num = (value: unknown): number | undefined => (typeof value === "number" ? value : undefined);

/** One line of the engine's output turned into what the page needs to know (or nothing). */
export function readEngineLine(line: string): AssistantEvent[] {
  let message: Json | null;
  try {
    message = obj(JSON.parse(line));
  } catch {
    return [];
  }
  if (!message) return [];
  if (message.type === "system" && message.subtype === "init") {
    const tools = Array.isArray(message.tools) ? message.tools.map(String) : [];
    return [
      {
        type: "ready",
        tools: tools.map((tool) => (tool.startsWith(TOOL_PREFIX) ? tool.slice(TOOL_PREFIX.length) : tool)),
        subscription: message.apiKeySource === "none",
        model: String(message.model ?? ""),
      },
    ];
  }
  if (message.type === "stream_event") {
    const delta = obj(obj(message.event)?.delta);
    return delta?.type === "text_delta" && typeof delta.text === "string" && delta.text
      ? [{ type: "delta", text: delta.text }]
      : [];
  }
  if (message.type === "assistant") {
    const content = obj(message.message)?.content;
    if (!Array.isArray(content)) return [];
    const events: AssistantEvent[] = [];
    for (const block of content.map(obj)) {
      if (block?.type === "text" && typeof block.text === "string" && block.text.trim())
        events.push({ type: "message", text: block.text });
      else if (block?.type === "tool_use" && typeof block.name === "string")
        events.push({
          type: "tool",
          name: block.name.startsWith(TOOL_PREFIX) ? block.name.slice(TOOL_PREFIX.length) : block.name,
        });
    }
    return events;
  }
  if (message.type === "result") {
    const ok = message.subtype === "success" && message.is_error !== true;
    return [{ type: "done", ok, ...(ok ? {} : { error: String(message.result ?? message.subtype ?? "erro") }) }];
  }
  if (message.type === "rate_limit_event") {
    const info = obj(message.rate_limit_info);
    if (!info) return [];
    const windows = obj(info.unifiedWindows);
    return [
      {
        type: "usage",
        status: String(info.status ?? ""),
        fiveHour: num(obj(windows?.five_hour)?.utilization),
        sevenDay: num(obj(windows?.seven_day)?.utilization),
        resetsAt: num(info.resetsAt),
      },
    ];
  }
  return [];
}

/** What `claude auth status` says, read without trusting its shape. */
export function readAuthStatus(
  output: string,
  now: Date,
): { state: "ready" | "logged-out" | "expired"; plan?: string; loginExpiresAt?: string } {
  let parsed: Json | null = null;
  try {
    parsed = obj(JSON.parse(output));
  } catch {
    // An older Claude Code printing text: it answered, so it is there; the first message tells the rest.
    return { state: /not logged in/i.test(output) ? "logged-out" : "ready" };
  }
  if (!parsed || parsed.loggedIn !== true) return { state: "logged-out" };
  const expires = typeof parsed.loginExpiresAt === "string" ? parsed.loginExpiresAt : undefined;
  const plan = typeof parsed.subscriptionType === "string" ? parsed.subscriptionType : undefined;
  const expired = expires !== undefined && new Date(expires).getTime() <= now.getTime();
  return { state: expired ? "expired" : "ready", plan, loginExpiresAt: expires };
}
