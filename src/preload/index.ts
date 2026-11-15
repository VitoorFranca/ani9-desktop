// Preload of the main window: exposes `window.ani9Desktop` (src/shared/bridge.ts)
// to the ANI-9 page. It only forwards messages; the main process checks where
// each one came from and what it carries before acting.

import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import { BRIDGE_VERSION, CHANNELS, type Ani9Desktop, type Notice } from "../shared/bridge-constants.js";

const version = process.argv.find((arg) => arg.startsWith("--ani9-version="))?.split("=")[1] ?? "0.0.0";

function subscribe(channel: string, listener: (value: string) => void): () => void {
  const handler = (_event: IpcRendererEvent, value: unknown) => {
    if (typeof value === "string") listener(value);
  };
  ipcRenderer.on(channel, handler);
  // Tells the app the page handles this message itself (no full reload needed).
  ipcRenderer.send(CHANNELS.listening, channel);
  return () => {
    ipcRenderer.removeListener(channel, handler);
  };
}

const bridge: Ani9Desktop = {
  bridge: BRIDGE_VERSION,
  version,
  notify: (notice: Notice) => ipcRenderer.send(CHANNELS.notify, notice),
  setBadge: (count: number) => ipcRenderer.send(CHANNELS.setBadge, count),
  onNavigate: (listener) => subscribe(CHANNELS.navigate, listener),
  onTaskDone: (listener) => subscribe(CHANNELS.taskDone, listener),
};

contextBridge.exposeInMainWorld("ani9Desktop", Object.freeze(bridge));
