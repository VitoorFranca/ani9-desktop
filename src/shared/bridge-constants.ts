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
} as const;

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
}

/** Text for the Dock: empty clears it, very large counts are shortened. */
export function badgeText(count: number): string {
  if (count <= 0) return "";
  return count > 9999 ? "9999+" : String(count);
}
