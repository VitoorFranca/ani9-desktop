// Notices (Rotina reminders, Foco, new version). First the macOS notification;
// when macOS refuses it (it does for apps without an Apple signature), the
// app's own panel in the corner of the screen, with the same "Abrir" and
// "Feita". The panel floats over other apps and never takes the focus.

import { BrowserWindow, Notification, app, ipcMain, screen } from "electron";
import type { Notice } from "../shared/bridge.js";
import { addNotice, removeNotice } from "./noticeList.js";

export interface AppNotice extends Notice {
  /** A page outside the app opened by "Abrir" (only the app itself sets it, e.g. a new version). */
  link?: string;
}

export const PANEL_CHANNELS = { list: "aviso:list", act: "aviso:act", height: "aviso:height" } as const;

const WIDTH = 380;
const MARGIN = 12;

export function createNotifier(options: {
  preload: string;
  html: string;
  onOpen: (notice: AppNotice) => void;
  onDone: (taskId: string) => void;
}) {
  // null: not tried yet in this run.
  let nativeWorks: boolean | null = Notification.isSupported() ? null : false;
  const natives = new Map<string, Notification>();
  let list: AppNotice[] = [];
  let panel: BrowserWindow | null = null;
  let panelReady: Promise<void> | null = null;

  function createPanel(): Promise<void> {
    panel = new BrowserWindow({
      width: WIDTH,
      height: 120,
      show: false,
      frame: false,
      transparent: true,
      hasShadow: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      type: "panel",
      title: "Avisos do ANI-9",
      webPreferences: { preload: options.preload, sandbox: true, contextIsolation: true, nodeIntegration: false },
    });
    panel.setAlwaysOnTop(true, "floating");
    panel.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    panel.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    panel.webContents.on("will-navigate", (event) => event.preventDefault());
    panel.on("closed", () => {
      panel = null;
      panelReady = null;
    });
    return panel.loadFile(options.html);
  }

  async function renderPanel() {
    if (list.length === 0) {
      panel?.hide();
      return;
    }
    if (!panel) panelReady = createPanel();
    await panelReady;
    panel?.webContents.send(
      PANEL_CHANNELS.list,
      list.map(({ tag, title, body, taskId }) => ({ tag, title, body, done: !!taskId })),
    );
  }

  function placePanel(height: number) {
    if (!panel) return;
    const area = screen.getPrimaryDisplay().workArea;
    const h = Math.max(60, Math.min(Math.ceil(height), area.height - 2 * MARGIN));
    panel.setBounds({ x: area.x + area.width - WIDTH - MARGIN, y: area.y + MARGIN, width: WIDTH, height: h });
    if (!panel.isVisible()) panel.showInactive();
  }

  ipcMain.on(PANEL_CHANNELS.height, (event, height: unknown) => {
    if (!panel || event.sender !== panel.webContents || typeof height !== "number" || !Number.isFinite(height)) return;
    placePanel(height);
  });

  ipcMain.on(PANEL_CHANNELS.act, (event, tag: unknown, action: unknown) => {
    if (!panel || event.sender !== panel.webContents || typeof tag !== "string") return;
    const { list: rest, removed } = removeNotice(list, tag);
    list = rest;
    void renderPanel();
    if (!removed) return;
    if (action === "open") options.onOpen(removed);
    if (action === "done" && removed.taskId) options.onDone(removed.taskId);
  });

  function showInPanel(notice: AppNotice) {
    list = addNotice(list, notice);
    void renderPanel();
    if (process.platform === "darwin") app.dock?.bounce("informational");
  }

  function showNative(notice: AppNotice) {
    natives.get(notice.tag)?.close();
    const native = new Notification({
      title: notice.title,
      body: notice.body ?? "",
      // The page plays its own sound.
      silent: true,
      actions: notice.taskId ? [{ type: "button", text: "Feita" }] : [],
    });
    natives.set(notice.tag, native);
    const forget = () => {
      if (natives.get(notice.tag) === native) natives.delete(notice.tag);
    };
    native.on("show", () => {
      nativeWorks = true;
    });
    native.on("failed", () => {
      nativeWorks = false;
      forget();
      showInPanel(notice);
    });
    native.on("click", () => {
      forget();
      options.onOpen(notice);
    });
    native.on("action", () => {
      forget();
      if (notice.taskId) options.onDone(notice.taskId);
    });
    native.on("close", forget);
    native.show();
  }

  return {
    notify(notice: AppNotice) {
      if (nativeWorks === false) showInPanel(notice);
      else showNative(notice);
    },
    /** Whether macOS notifications work in this run (null: not tried yet). */
    get nativeWorks() {
      return nativeWorks;
    },
  };
}
