// Preload of the notices panel (static/aviso.html): receives the list and
// sends back what the person chose. Nothing else reaches the page.

import { contextBridge, ipcRenderer } from "electron";

interface PanelNotice {
  tag: string;
  title: string;
  body?: string;
  done: boolean;
}

contextBridge.exposeInMainWorld("aviso", {
  onList(listener: (notices: PanelNotice[]) => void) {
    ipcRenderer.on("aviso:list", (_event, notices: PanelNotice[]) => listener(notices));
  },
  act(tag: string, action: "open" | "done" | "close") {
    ipcRenderer.send("aviso:act", tag, action);
  },
  height(pixels: number) {
    ipcRenderer.send("aviso:height", pixels);
  },
});
