// The host of the Assistente's engine: finds the Claude Code installed on
// this Mac, starts it for a conversation with the fixed profile of
// assistantProfile.ts, passes the person's messages in and the answers out.
// The page may hold a few conversations at once (the orb's and the chat's),
// each on its own channel with its own engine. The host never sees the
// Claude credentials (Claude Code reads its own from the Keychain) and has no
// tutor text or domain rule of its own.

import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomBytes } from "node:crypto";
import { accessSync, constants, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_CHANNEL,
  MAX_CHANNELS,
  type AssistantEvent,
  type AssistantStart,
  type AssistantStatus,
} from "../shared/bridge-constants.js";
import {
  claudeCandidates,
  engineArgs,
  engineEnv,
  foreignTools,
  readAuthStatus,
  readEngineLine,
  reportedTools,
  toolsConfig,
  userLine,
} from "./assistantProfile.js";

/** An engine nobody talked to for this long is closed; the page starts it again when needed. */
export const IDLE_MS = 20 * 60_000;

type Closing = "stopped" | "unsafe" | "idle";

interface Session {
  channel: string;
  child: ChildProcessWithoutNullStreams;
  toolsFile: string;
  closing: Closing | null;
  lastActive: number;
  /** A message was sent and its turn has not ended. */
  answering: boolean;
}

export function createAssistantHost(options: {
  appOrigin: string;
  /** A folder of the app's own (under userData) for the tools files and an empty working directory. */
  dataDir: string;
  emit: (event: AssistantEvent) => void;
  /**
   * Told whenever the number of conversations with an answer under way
   * changes, so the app can keep the Mac from sleeping in the middle of one.
   */
  onAnswering?: (count: number) => void;
  now?: () => number;
}) {
  const sessions = new Map<string, Session>();
  const now = options.now ?? Date.now;
  let answeringCount = 0;

  function setAnswering(session: Session, answering: boolean) {
    if (session.answering === answering) return;
    session.answering = answering;
    const count = [...sessions.values()].filter((entry) => entry.answering).length;
    if (count !== answeringCount) options.onAnswering?.((answeringCount = count));
  }

  function findClaude(): string | null {
    for (const path of claudeCandidates(homedir())) {
      try {
        accessSync(path, constants.X_OK);
        return path;
      } catch {
        // Try the next place.
      }
    }
    return null;
  }

  function run(path: string, args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile(path, args, { env: engineEnv(process.env), timeout: 15_000 }, (error, stdout) =>
        error ? reject(error) : resolve(stdout),
      );
    });
  }

  async function status(): Promise<AssistantStatus> {
    const path = findClaude();
    if (!path) return { state: "missing" };
    try {
      const [version, auth] = await Promise.all([
        run(path, ["--version"]).catch(() => ""),
        run(path, ["auth", "status"]),
      ]);
      return { ...readAuthStatus(auth, new Date()), version: version.trim().split(" ")[0] || undefined };
    } catch (error) {
      // `claude auth status` exits with an error when nobody is signed in.
      const output = String((error as { stdout?: unknown }).stdout ?? "");
      if (output.trim()) return readAuthStatus(output, new Date());
      return { state: "error", detail: error instanceof Error ? error.message.slice(0, 300) : "erro" };
    }
  }

  function end(session: Session, reason: Closing) {
    if (session.closing) return;
    session.closing = reason;
    session.child.kill("SIGTERM");
  }

  /** Ends a session and waits for its process to go (or gives up waiting). */
  function ended(session: Session): Promise<void> {
    return new Promise((resolve) => {
      session.child.once("exit", () => resolve());
      end(session, "stopped");
      setTimeout(resolve, 3000);
    });
  }

  // Engines left alone are closed, so a forgotten conversation does not hold memory for hours.
  const sweep = setInterval(() => {
    for (const session of sessions.values()) {
      if (now() - session.lastActive > IDLE_MS) end(session, "idle");
    }
  }, 60_000);
  sweep.unref();

  async function start(config: AssistantStart): Promise<{ ok: boolean; error?: string }> {
    const path = findClaude();
    if (!path) return { ok: false, error: "Claude Code não encontrado neste Mac." };
    const channel = config.channel ?? DEFAULT_CHANNEL;
    const previous = sessions.get(channel);
    if (previous) await ended(previous);
    // Room for the new one: the conversation left alone the longest gives way.
    while (sessions.size >= MAX_CHANNELS) {
      const oldest = [...sessions.values()].sort((a, b) => a.lastActive - b.lastActive)[0]!;
      await ended(oldest);
      if (sessions.get(oldest.channel) === oldest) sessions.delete(oldest.channel);
    }

    const cwd = join(options.dataDir, "vazio");
    mkdirSync(cwd, { recursive: true });
    // The token goes in a file only this user reads, never in the command line.
    const toolsFile = join(options.dataDir, `ferramentas-${randomBytes(6).toString("hex")}.json`);
    writeFileSync(toolsFile, toolsConfig(options.appOrigin, config.token), { mode: 0o600 });

    const child = spawn(path, engineArgs(config, toolsFile), { cwd, env: engineEnv(process.env) });
    const session: Session = { channel, child, toolsFile, closing: null, lastActive: now(), answering: false };
    sessions.set(channel, session);
    const current = () => sessions.get(channel) === session;
    const emit = (event: AssistantEvent) => options.emit({ ...event, channel });

    let buffer = "";
    let errors = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buffer += chunk;
      let lineEnd: number;
      while ((lineEnd = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, lineEnd).trim();
        buffer = buffer.slice(lineEnd + 1);
        if (!line) continue;
        // The self-test, on every turn: the engine may have nothing but the ANI-9's tools.
        const tools = reportedTools(line);
        if (tools && foreignTools(tools).length > 0) {
          if (current()) end(session, "unsafe");
          return;
        }
        if (!current() || session.closing === "unsafe") continue;
        session.lastActive = now();
        for (const event of readEngineLine(line)) {
          if (event.type === "done") setAnswering(session, false);
          emit(event);
        }
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      errors = (errors + chunk).slice(-1500);
    });
    child.on("error", (error) => {
      if (current()) emit({ type: "closed", reason: "failed", detail: error.message });
    });
    child.on("exit", (code) => {
      rmSync(toolsFile, { force: true });
      setAnswering(session, false);
      if (!current()) return;
      sessions.delete(channel);
      const reason = session.closing ?? (code === 0 ? "exited" : "failed");
      emit({ type: "closed", reason, ...(reason === "failed" ? { detail: errors.trim().slice(-500) } : {}) });
    });
    return { ok: true };
  }

  return {
    status,
    start,
    send(text: string, channel = DEFAULT_CHANNEL) {
      const session = sessions.get(channel);
      if (!session?.child.stdin.writable) return;
      session.lastActive = now();
      setAnswering(session, true);
      session.child.stdin.write(userLine(text));
    },
    /** Ends the answer being written; Claude Code may close, and the page starts it again. */
    interrupt(channel = DEFAULT_CHANNEL) {
      sessions.get(channel)?.child.kill("SIGINT");
    },
    /** One conversation's engine, or all of them (a page load forgets every conversation). */
    stop(channel?: string) {
      for (const session of sessions.values()) {
        if (channel === undefined || session.channel === channel) end(session, "stopped");
      }
    },
    /** On quit: nothing of any conversation stays behind. */
    dispose() {
      clearInterval(sweep);
      for (const session of sessions.values()) {
        session.child.kill("SIGKILL");
        rmSync(session.toolsFile, { force: true });
      }
      sessions.clear();
    },
  };
}

export type AssistantHost = ReturnType<typeof createAssistantHost>;
