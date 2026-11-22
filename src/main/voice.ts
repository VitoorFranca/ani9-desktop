// The Assistente's voice on this Mac: a process of our own (native/voz, in
// Rust) that turns speech into text and text into speech with local models.
// It starts when the person first talks or the assistant first speaks, and
// stops after a few idle minutes, so it holds no memory and spends no battery
// while unused. The models are downloaded once, on the person's request.

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { VoiceEvent, VoiceStatus } from "../shared/bridge-constants.js";

const RELEASES = "https://github.com/k2-fsa/sherpa-onnx/releases/download";

/** What the voice needs, where it comes from, and how much it weighs (to show progress). */
export const VOICE_MODELS = [
  { path: "silero_vad.onnx", url: `${RELEASES}/asr-models/silero_vad.onnx`, size: 643_854, archive: false },
  {
    path: "vits-piper-pt_BR-faber-medium-int8",
    url: `${RELEASES}/tts-models/vits-piper-pt_BR-faber-medium-int8.tar.bz2`,
    size: 21_000_000,
    archive: true,
  },
  {
    path: "sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8",
    url: `${RELEASES}/asr-models/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8.tar.bz2`,
    size: 487_000_000,
    archive: true,
  },
] as const;

export const VOICE_NAME = "vits-piper-pt_BR-faber-medium-int8";
/** Idle this long, the process ends and gives its memory back. */
const IDLE_MS = 5 * 60 * 1000;

export interface VoiceHost {
  status(): VoiceStatus;
  install(): Promise<{ ok: boolean; error?: string }>;
  listen(): { ok: boolean; error?: string };
  audio(samples: Float32Array): void;
  stop(): void;
  cancel(): void;
  say(id: number, text: string): void;
  hush(): void;
  dispose(): void;
}

export function createVoiceHost(options: {
  /** The engine's executable, or null when this build has none. */
  binary: string | null;
  modelsDir: string;
  emit: (event: VoiceEvent) => void;
}): VoiceHost {
  let child: ChildProcessWithoutNullStreams | null = null;
  let idle: NodeJS.Timeout | null = null;
  let installing: Promise<{ ok: boolean; error?: string }> | null = null;
  let progress = 0;

  const has = (path: string) => existsSync(join(options.modelsDir, path));
  const missing = () => VOICE_MODELS.filter((model) => !has(model.path));

  function status(): VoiceStatus {
    if (!options.binary || !existsSync(options.binary))
      return { state: "unavailable", detail: "Esta versão do app não tem o motor de voz." };
    if (installing) return { state: "installing", progress };
    const lacking = missing();
    if (lacking.length > 0) return { state: "missing", size: lacking.reduce((sum, model) => sum + model.size, 0) };
    return { state: "ready" };
  }

  function touch() {
    if (idle) clearTimeout(idle);
    idle = setTimeout(() => close(), IDLE_MS);
  }

  function close() {
    if (idle) clearTimeout(idle);
    idle = null;
    child?.kill();
    child = null;
  }

  function engine(): ChildProcessWithoutNullStreams | null {
    touch();
    if (child) return child;
    if (status().state !== "ready") return null;
    const started = spawn(options.binary!, ["--modelos", options.modelsDir, "--voz", VOICE_NAME], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    child = started;
    createInterface({ input: started.stdout }).on("line", (line) => {
      let event: Record<string, unknown>;
      try {
        event = JSON.parse(line) as Record<string, unknown>;
      } catch {
        return;
      }
      switch (event.event) {
        case "speech":
          return options.emit({ type: "speech" });
        case "nothing":
          return options.emit({ type: "nothing" });
        case "heard":
          return options.emit({ type: "heard", text: String(event.text ?? "") });
        case "said":
          return options.emit({ type: "said", id: Number(event.id) });
        case "error":
          return options.emit({ type: "error", message: String(event.message ?? "Erro na voz.") });
        case "audio": {
          const bytes = Buffer.from(String(event.pcm ?? ""), "base64");
          const samples = new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
          return options.emit({ type: "audio", id: Number(event.id), rate: Number(event.rate), samples });
        }
      }
    });
    // Its diagnostics are not the page's business; drained so the pipe never fills.
    started.stderr.resume();
    started.on("exit", (code) => {
      if (child === started) child = null;
      if (code && code !== 0) options.emit({ type: "error", message: "O motor de voz parou." });
    });
    return started;
  }

  function write(command: Record<string, unknown>) {
    const process = engine();
    if (process?.stdin.writable) process.stdin.write(`${JSON.stringify(command)}\n`);
  }

  async function download() {
    mkdirSync(options.modelsDir, { recursive: true });
    const lacking = missing();
    const total = lacking.reduce((sum, model) => sum + model.size, 0);
    let done = 0;
    for (const model of lacking) {
      const response = await fetch(model.url);
      if (!response.ok || !response.body) throw new Error(`Falha ao baixar (${response.status}).`);
      const part = join(options.modelsDir, `${model.path}.parte`);
      let last = 0;
      const counted = Readable.fromWeb(response.body as never).on("data", (chunk: Buffer) => {
        done += chunk.length;
        progress = Math.min(0.99, done / total);
        if (progress - last >= 0.01) {
          last = progress;
          options.emit({ type: "status", status: { state: "installing", progress } });
        }
      });
      await pipeline(counted, createWriteStream(part));
      if (model.archive) {
        await new Promise<void>((resolve, reject) => {
          const tar = spawn("tar", ["-xjf", part, "-C", options.modelsDir], { stdio: "ignore" });
          tar.on("exit", (code) => (code === 0 ? resolve() : reject(new Error("Falha ao abrir o arquivo baixado."))));
          tar.on("error", reject);
        });
        rmSync(part, { force: true });
      } else {
        renameSync(part, join(options.modelsDir, model.path));
      }
    }
  }

  return {
    status,
    install() {
      if (status().state === "ready") return Promise.resolve({ ok: true });
      installing ??= download()
        .then(() => ({ ok: true }))
        .catch((error: unknown) => ({ ok: false, error: error instanceof Error ? error.message : "Falha ao baixar." }))
        .finally(() => {
          installing = null;
          progress = 0;
          options.emit({ type: "status", status: status() });
        });
      options.emit({ type: "status", status: status() });
      return installing;
    },
    listen() {
      const state = status().state;
      if (state !== "ready") return { ok: false, error: state };
      write({ cmd: "listen" });
      return { ok: true };
    },
    audio(samples) {
      if (!child) return;
      write({
        cmd: "audio",
        pcm: Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength).toString("base64"),
      });
    },
    stop: () => child && write({ cmd: "stop" }),
    cancel: () => child && write({ cmd: "cancel" }),
    say(id, text) {
      if (status().state === "ready") write({ cmd: "say", id, text });
    },
    hush: () => child && write({ cmd: "hush" }),
    dispose: close,
  };
}
