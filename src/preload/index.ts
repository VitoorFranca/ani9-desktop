// Preload of the main window: exposes `window.ani9Desktop` (src/shared/bridge.ts)
// to the ANI-9 page. It only forwards messages; the main process checks where
// each one came from and what it carries before acting.

import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import {
  BRIDGE_VERSION,
  CHANNELS,
  type Ani9Assistant,
  type AssistantAttachment,
  type GenerationRequest,
  type Ani9Desktop,
  type AssistantEvent,
  type AssistantStart,
  type AssistantStatus,
  type Ani9Voice,
  type Notice,
  type VoiceEvent,
  type VoiceStatus,
} from "../shared/bridge-constants.js";

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

const voice: Ani9Voice = {
  status: () => ipcRenderer.invoke(CHANNELS.voiceStatus) as Promise<VoiceStatus>,
  install: () => ipcRenderer.invoke(CHANNELS.voiceInstall) as Promise<{ ok: boolean; error?: string }>,
  listen: () => ipcRenderer.invoke(CHANNELS.voiceListen) as Promise<{ ok: boolean; error?: string }>,
  audio: (samples: Float32Array) => ipcRenderer.send(CHANNELS.voiceAudio, samples),
  stop: () => ipcRenderer.send(CHANNELS.voiceStop),
  cancel: () => ipcRenderer.send(CHANNELS.voiceCancel),
  say: (id: number, text: string) => ipcRenderer.send(CHANNELS.voiceSay, id, text),
  hush: () => ipcRenderer.send(CHANNELS.voiceHush),
  wake: (on: boolean) => ipcRenderer.send(CHANNELS.voiceWake, on === true),
  onEvent(listener: (event: VoiceEvent) => void) {
    const handler = (_event: IpcRendererEvent, value: VoiceEvent) => listener(value);
    ipcRenderer.on(CHANNELS.voiceEvent, handler);
    return () => {
      ipcRenderer.removeListener(CHANNELS.voiceEvent, handler);
    };
  },
};

const assistant: Ani9Assistant = {
  channels: true,
  status: () => ipcRenderer.invoke(CHANNELS.assistantStatus) as Promise<AssistantStatus>,
  start: (config: AssistantStart) =>
    ipcRenderer.invoke(CHANNELS.assistantStart, config) as Promise<{ ok: boolean; error?: string }>,
  attachments: true,
  generate: (request: GenerationRequest) =>
    ipcRenderer.invoke(CHANNELS.assistantGenerate, request) as Promise<{ ok: boolean; text?: string; error?: string }>,
  send: (text: string, channel?: string, attachments?: AssistantAttachment[]) =>
    ipcRenderer.send(CHANNELS.assistantSend, text, channel, attachments ?? []),
  interrupt: (channel?: string) => ipcRenderer.send(CHANNELS.assistantInterrupt, channel),
  stop: (channel?: string) => ipcRenderer.send(CHANNELS.assistantStop, channel),
  onEvent: (listener) => {
    const handler = (_event: IpcRendererEvent, value: unknown) => {
      if (value && typeof value === "object") listener(value as AssistantEvent);
    };
    ipcRenderer.on(CHANNELS.assistantEvent, handler);
    return () => {
      ipcRenderer.removeListener(CHANNELS.assistantEvent, handler);
    };
  },
};

const bridge: Ani9Desktop = {
  bridge: BRIDGE_VERSION,
  version,
  notify: (notice: Notice) => ipcRenderer.send(CHANNELS.notify, notice),
  setBadge: (count: number) => ipcRenderer.send(CHANNELS.setBadge, count),
  onNavigate: (listener) => subscribe(CHANNELS.navigate, listener),
  onTaskDone: (listener) => subscribe(CHANNELS.taskDone, listener),
  assistant: Object.freeze(assistant),
  voice: Object.freeze(voice),
};

contextBridge.exposeInMainWorld("ani9Desktop", Object.freeze(bridge));
