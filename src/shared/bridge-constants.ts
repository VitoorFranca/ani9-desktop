// The contract between the ANI-9 web client and this app, without zod (the
// preload imports only this file). The page reads it as `window.ani9Desktop`.

/** Bumped only on an incompatible change; the web client checks it before using the bridge. */
export const BRIDGE_VERSION = 1;

export const CHANNELS = {
  notify: "ani9:notify",
  setBadge: "ani9:set-badge",
  navigate: "ani9:navigate",
  taskDone: "ani9:task-done",
  /** The page handles navigate/taskDone itself (sent once per subscription). */
  listening: "ani9:listening",
  assistantStatus: "ani9:assistant-status",
  assistantStart: "ani9:assistant-start",
  assistantSend: "ani9:assistant-send",
  assistantInterrupt: "ani9:assistant-interrupt",
  assistantStop: "ani9:assistant-stop",
  assistantEvent: "ani9:assistant-event",
} as const;

/** Models the page may ask for, as Claude Code names them ("default" = the plan's own default). */
export const ASSISTANT_MODELS = ["default", "opus", "sonnet", "haiku", "fable"] as const;

/** Whether the Assistente's engine (the Claude Code installed on this Mac) can run. */
export interface AssistantStatus {
  state: "ready" | "missing" | "logged-out" | "expired" | "error";
  /** Claude Code's version, when found. */
  version?: string;
  /** The person's plan ("max", "pro"…), when Claude Code says it. */
  plan?: string;
  loginExpiresAt?: string;
  detail?: string;
}

/** The conversation a page talks to when it names none (and the only one before 0.3.0). */
export const DEFAULT_CHANNEL = "principal";
/** Conversations kept alive at once (the orb's and the chat's, and one to spare). */
export const MAX_CHANNELS = 3;

/** What the page sends to open a conversation; the app decides everything else about the engine. */
export interface AssistantStart {
  /** The tutor's text, from the ANI-9 server. */
  systemPrompt: string;
  /** Opens the ANI-9 tools for this conversation only. */
  token: string;
  model: (typeof ASSISTANT_MODELS)[number];
  /**
   * Which of the page's conversations this is ("assistente", "chat"…). Each
   * has its own engine; starting one leaves the others running.
   */
  channel?: string | undefined;
}

type AssistantEventBody =
  /** The engine is up: the tools it has, and whether it runs on the person's plan (not an API key). */
  | { type: "ready"; tools: string[]; subscription: boolean; model: string }
  | { type: "delta"; text: string }
  /** A whole message of the assistant (the deltas, joined). */
  | { type: "message"; text: string }
  /** It called a tool (`id` pairs it with the `toolDone` that follows). */
  | { type: "tool"; name: string; id?: string }
  /** A tool it called answered. */
  | { type: "toolDone"; id?: string; ok: boolean }
  /** The turn ended. */
  | { type: "done"; ok: boolean; error?: string }
  /** How much of the plan's limits is used (0 to 1), when Claude Code tells. */
  | { type: "usage"; status: string; fiveHour?: number; sevenDay?: number; resetsAt?: number }
  /** The engine stopped (asked to, by itself, or after a long silence). */
  | { type: "closed"; reason: "stopped" | "exited" | "unsafe" | "failed" | "idle"; detail?: string };

/** `channel`: the conversation the event belongs to (absent before 0.3.0). */
export type AssistantEvent = AssistantEventBody & { channel?: string };

export interface Ani9Assistant {
  /** Present from 0.3.0: several conversations run at once, each on its channel. */
  channels?: true;
  status(): Promise<AssistantStatus>;
  /** Starts the engine for one conversation. It replaces only the engine of the same channel. */
  start(config: AssistantStart): Promise<{ ok: boolean; error?: string }>;
  send(text: string, channel?: string): void;
  /** Stops the answer being written. The engine may close; start again to go on. */
  interrupt(channel?: string): void;
  /** Stops one conversation's engine, or all of them when no channel is given. */
  stop(channel?: string): void;
  onEvent(listener: (event: AssistantEvent) => void): () => void;
}

export interface Notice {
  /** Showing a notice with the same tag replaces the previous one. */
  tag: string;
  title: string;
  body?: string;
  /** Screen opened when the notice is clicked, a path inside the app ("/rotina"). */
  url?: string;
  /** Present: the notice offers "Feita", which tells the page to finish this task. */
  taskId?: string;
}

/** What the page sees as `window.ani9Desktop`. */
export interface Ani9Desktop {
  bridge: typeof BRIDGE_VERSION;
  /** Version of the desktop app, e.g. "0.1.0". */
  version: string;
  notify(notice: Notice): void;
  /** Number on the Dock icon; 0 clears it. */
  setBadge(count: number): void;
  /** A notice or menu item asks the page to open a screen (a path inside the app). */
  onNavigate(listener: (url: string) => void): () => void;
  /** "Feita" in a notice: the page finishes this task. */
  onTaskDone(listener: (taskId: string) => void): () => void;
  /** The Assistente's engine. Absent in app versions before 0.2.0. */
  assistant?: Ani9Assistant;
}

/** Text for the Dock: empty clears it, very large counts are shortened. */
export function badgeText(count: number): string {
  if (count <= 0) return "";
  return count > 9999 ? "9999+" : String(count);
}
