// The host of the Assistente's engine: finds the Claude Code installed on
// this Mac, starts it for one conversation with the fixed profile of
// assistantProfile.ts, passes the person's messages in and the answers out.
// It never sees the Claude credentials (Claude Code reads its own from the
// Keychain) and has no tutor text or domain rule of its own.

import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomBytes } from "node:crypto";
import { accessSync, constants, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AssistantEvent, AssistantStart, AssistantStatus } from "../shared/bridge-constants.js";
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

export function createAssistantHost(options: {
  appOrigin: string;
  /** A folder of the app's own (under userData) for the tools file and an empty working directory. */
  dataDir: string;
  emit: (event: AssistantEvent) => void;
}) {
  let child: ChildProcessWithoutNullStreams | null = null;
  let toolsFile: string | null = null;
  let closing: "stopped" | "unsafe" | null = null;

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

  function cleanup() {
    if (toolsFile) rmSync(toolsFile, { force: true });
    toolsFile = null;
  }

  function stop(reason: "stopped" | "unsafe" = "stopped") {
    if (!child) return;
    closing = reason;
    child.kill("SIGTERM");
  }

  async function start(config: AssistantStart): Promise<{ ok: boolean; error?: string }> {
    const path = findClaude();
    if (!path) return { ok: false, error: "Claude Code não encontrado neste Mac." };
    if (child) {
      const previous = child;
      await new Promise<void>((resolve) => {
        previous.once("exit", () => resolve());
        stop();
        setTimeout(resolve, 3000);
      });
    }
    const cwd = join(options.dataDir, "vazio");
    mkdirSync(cwd, { recursive: true });
    // The token goes in a file only this user reads, never in the command line.
    const file = join(options.dataDir, `ferramentas-${randomBytes(6).toString("hex")}.json`);
    writeFileSync(file, toolsConfig(options.appOrigin, config.token), { mode: 0o600 });
    toolsFile = file;
    closing = null;

    const started = spawn(path, engineArgs(config, file), { cwd, env: engineEnv(process.env) });
    child = started;
    let buffer = "";
    let errors = "";
    started.stdout.setEncoding("utf8");
    started.stdout.on("data", (chunk: string) => {
      buffer += chunk;
      let end: number;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, end).trim();
        buffer = buffer.slice(end + 1);
        if (!line) continue;
        // The self-test, on every turn: the engine may have nothing but the ANI-9's tools.
        const tools = reportedTools(line);
        if (tools && foreignTools(tools).length > 0) {
          if (child === started) stop("unsafe");
          return;
        }
        if (child !== started || closing === "unsafe") continue;
        for (const event of readEngineLine(line)) options.emit(event);
      }
    });
    started.stderr.setEncoding("utf8");
    started.stderr.on("data", (chunk: string) => {
      errors = (errors + chunk).slice(-1500);
    });
    started.on("error", (error) => {
      if (child === started) options.emit({ type: "closed", reason: "failed", detail: error.message });
    });
    started.on("exit", (code) => {
      if (toolsFile === file) cleanup();
      else rmSync(file, { force: true });
      if (child !== started) return;
      child = null;
      const reason = closing ?? (code === 0 ? "exited" : "failed");
      closing = null;
      options.emit({ type: "closed", reason, ...(reason === "failed" ? { detail: errors.trim().slice(-500) } : {}) });
    });
    return { ok: true };
  }

  return {
    status,
    start,
    send(text: string) {
      if (child?.stdin.writable) child.stdin.write(userLine(text));
    },
    /** Ends the answer being written; Claude Code may close, and the page starts it again. */
    interrupt() {
      child?.kill("SIGINT");
    },
    stop: () => stop("stopped"),
    /** On quit: nothing of the conversation stays behind. */
    dispose() {
      child?.kill("SIGKILL");
      cleanup();
    },
  };
}

export type AssistantHost = ReturnType<typeof createAssistantHost>;
