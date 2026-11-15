// ANI-9 for macOS: the ANI-9 web app in its own window, plus what a browser
// tab cannot do — notices with the window closed, the number on the Dock,
// native menus, links opening in the browser and a new-version notice. The
// interface comes from the web, so each web deploy reaches the app on the
// next load; there is no domain logic here.

import {
  BrowserWindow,
  Menu,
  app,
  dialog,
  ipcMain,
  nativeTheme,
  net,
  screen,
  session,
  shell,
  type IpcMainEvent,
  type WebContents,
} from "electron";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { CHANNELS, badgeSchema, badgeText, noticeSchema } from "../shared/bridge.js";
import { buildMenu } from "./menu.js";
import { appPathUrl, externalAction, isAppUrl, resolveAppUrl } from "./navigation.js";
import { createNotifier, type AppNotice } from "./notices.js";
import { RELEASES_URL, REPOSITORY, checkForUpdate, type Release } from "./updates.js";
import { MIN_SIZE, sanitizeState } from "./windowState.js";

const APP_NAME = "ANI-9";
const DAY_MS = 24 * 60 * 60 * 1000;
/** Permissions the ANI-9 page may use; notices go through the bridge, not web notifications. */
const ALLOWED_PERMISSIONS = new Set(["clipboard-sanitized-write", "fullscreen"]);

const appUrl = resolveAppUrl(process.env.ANI9_DESKTOP_URL);
const appOrigin = appUrl.origin;
const version = app.getVersion();
const here = __dirname;
const files = {
  preload: join(here, "preload.js"),
  noticePreload: join(here, "aviso-preload.js"),
  noticeHtml: join(here, "static", "aviso.html"),
  offlineHtml: join(here, "static", "offline.html"),
};

let win: BrowserWindow | null = null;
let quitting = false;
let update: Release | null = null;
/** The channels the page in the window handles itself (reset on every full page load). */
let listening = new Set<string>();

app.setName(APP_NAME);

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => showWindow());
  void app.whenReady().then(start);
}

function stateFile() {
  return join(app.getPath("userData"), "janela.json");
}

function readState() {
  try {
    return JSON.parse(readFileSync(stateFile(), "utf8")) as unknown;
  } catch {
    return null;
  }
}

function saveState() {
  if (!win || win.isDestroyed()) return;
  try {
    mkdirSync(dirname(stateFile()), { recursive: true });
    writeFileSync(stateFile(), JSON.stringify({ bounds: win.getNormalBounds(), maximized: win.isMaximized() }));
  } catch {
    // Only the window position is lost.
  }
}

/** Links that leave the app: web and e-mail in the default browser, the rest nowhere. */
function openOutside(url: string) {
  if (externalAction(url) === "open") void shell.openExternal(url);
}

function showWindow() {
  if (!win || win.isDestroyed()) createWindow();
  else {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  }
}

/** Opens a screen of the app: inside the page when it handles it, otherwise by loading the address. */
function go(path: string) {
  const full = appPathUrl(path, appOrigin);
  if (!full) return;
  showWindow();
  const contents = win?.webContents;
  if (!contents) return;
  if (listening.has(CHANNELS.navigate) && isAppUrl(contents.getURL(), appOrigin))
    contents.send(CHANNELS.navigate, path);
  else void contents.loadURL(full);
}

/** Messages count only from the ANI-9 page in the main window (its top frame). */
function fromApp(event: IpcMainEvent): boolean {
  const frame = event.senderFrame;
  return !!win && event.sender === win.webContents && !!frame && frame.parent === null && frame.origin === appOrigin;
}

function createWindow() {
  const state = sanitizeState(
    readState(),
    screen.getAllDisplays().map((display) => display.workArea),
  );
  win = new BrowserWindow({
    ...state.bounds,
    minWidth: MIN_SIZE.width,
    minHeight: MIN_SIZE.height,
    show: false,
    title: APP_NAME,
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#1a1915" : "#f6f2e7",
    webPreferences: {
      preload: files.preload,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      // The Rotina reminders run on the page's clock, also with the window closed.
      backgroundThrottling: false,
      spellcheck: true,
      additionalArguments: [`--ani9-version=${version}`],
    },
  });
  const current = win;
  if (state.maximized) current.maximize();
  const reveal = () => {
    if (!current.isDestroyed() && !current.isVisible()) current.show();
  };
  current.once("ready-to-show", reveal);
  setTimeout(reveal, 4000);

  let saveTimer: NodeJS.Timeout | undefined;
  const saveSoon = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveState, 500);
  };
  current.on("resize", saveSoon);
  current.on("move", saveSoon);

  // Closing hides: the app stays open (in the Dock) so reminders keep coming. ⌘Q quits.
  current.on("close", (event) => {
    saveState();
    if (quitting) return;
    event.preventDefault();
    if (current.isFullScreen()) {
      current.once("leave-full-screen", () => current.hide());
      current.setFullScreen(false);
    } else current.hide();
  });
  current.on("closed", () => {
    if (win === current) win = null;
  });

  const contents = current.webContents;
  contents.on("did-navigate", () => {
    listening = new Set();
  });
  contents.on("will-navigate", (event) => {
    if (isAppUrl(event.url, appOrigin)) return;
    event.preventDefault();
    openOutside(event.url);
  });
  contents.on("will-redirect", (event) => {
    if (!event.isMainFrame || isAppUrl(event.url, appOrigin)) return;
    event.preventDefault();
    openOutside(event.url);
  });
  contents.setWindowOpenHandler(({ url }) => {
    // A link to another screen of the ANI-9 opens in this window; other sites in the browser.
    if (isAppUrl(url, appOrigin)) void contents.loadURL(url);
    else openOutside(url);
    return { action: "deny" };
  });
  contents.on("did-fail-load", (_event, code, _description, url, isMainFrame) => {
    // -3: the load was replaced by another one, not a failure.
    if (!isMainFrame || code === -3 || !isAppUrl(url, appOrigin)) return;
    void contents.loadFile(files.offlineHtml, { query: { url } });
  });
  contents.on("render-process-gone", (_event, details) => {
    if (details.reason !== "clean-exit") setTimeout(() => !contents.isDestroyed() && contents.reload(), 1000);
  });

  void contents.loadURL(appUrl.href);
}

function setOpenAtLogin(on: boolean) {
  app.setLoginItemSettings({ openAtLogin: on });
  const settings = app.getLoginItemSettings();
  if (on && settings.status === "requires-approval") {
    void dialog.showMessageBox({
      type: "info",
      message: "Falta aprovar nos Ajustes do Sistema",
      detail: "Abra Ajustes do Sistema → Geral → Itens de Início e ative o ANI-9.",
    });
  }
  refreshMenu();
}

function refreshMenu() {
  Menu.setApplicationMenu(
    buildMenu({
      appName: APP_NAME,
      devTools: !app.isPackaged,
      openAtLogin: app.getLoginItemSettings().openAtLogin,
      update,
      go,
      back: () => win?.webContents.navigationHistory.goBack(),
      forward: () => win?.webContents.navigationHistory.goForward(),
      checkForUpdates: () => void lookForUpdate(true),
      downloadUpdate: () => update && void shell.openExternal(update.url),
      setOpenAtLogin,
      openWebsite: () => void shell.openExternal(appUrl.href),
      openReleases: () => void shell.openExternal(RELEASES_URL),
      openSource: () => void shell.openExternal(`https://github.com/${REPOSITORY}`),
    }),
  );
}

let notifier: ReturnType<typeof createNotifier>;

async function lookForUpdate(asked: boolean) {
  try {
    const found = await checkForUpdate(version, (url, init) => net.fetch(url, init));
    if (!found) {
      if (asked) {
        await dialog.showMessageBox({
          type: "info",
          message: "Você já tem a versão mais nova.",
          detail: `${APP_NAME} ${version}`,
        });
      }
      return;
    }
    const isNew = update?.version !== found.version;
    update = found;
    refreshMenu();
    if (asked) {
      const { response } = await dialog.showMessageBox({
        type: "info",
        message: `A versão ${found.version} está disponível.`,
        detail: `Você usa a ${version}. O app não se atualiza sozinho: baixe a versão nova e arraste para Aplicativos, substituindo a atual.`,
        buttons: ["Baixar", "Agora não"],
        defaultId: 0,
        cancelId: 1,
      });
      if (response === 0) void shell.openExternal(found.url);
    } else if (isNew) {
      notifier.notify({
        tag: "atualizacao",
        title: `Versão ${found.version} do app disponível`,
        body: "Abra para baixar. O app não se atualiza sozinho.",
        link: found.url,
      });
    }
  } catch {
    if (asked) {
      await dialog.showMessageBox({
        type: "warning",
        message: "Não deu para procurar atualizações agora.",
        detail: "Confira a conexão e tente de novo.",
      });
    }
  }
}

function openNotice(notice: AppNotice) {
  if (notice.link) {
    if (notice.link.startsWith(`${RELEASES_URL}/`)) void shell.openExternal(notice.link);
    return;
  }
  go(notice.url ?? "/");
}

function finishTask(taskId: string) {
  const contents = win?.webContents;
  if (contents && listening.has(CHANNELS.taskDone)) contents.send(CHANNELS.taskDone, taskId);
  // A page that cannot finish it here shows the task instead.
  else go("/rotina");
}

function guardSession() {
  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((_contents, permission, callback, details) => {
    callback(ALLOWED_PERMISSIONS.has(permission) && isAppUrl(details.requestingUrl, appOrigin));
  });
  ses.setPermissionCheckHandler((_contents, permission, requestingOrigin) => {
    return ALLOWED_PERMISSIONS.has(permission) && isAppUrl(requestingOrigin, appOrigin);
  });
  ses.on("will-download", (_event, item) => {
    item.setSaveDialogOptions({ title: "Salvar", defaultPath: join(app.getPath("downloads"), item.getFilename()) });
  });
}

function listen() {
  ipcMain.on(CHANNELS.notify, (event, payload: unknown) => {
    if (!fromApp(event)) return;
    const notice = noticeSchema.safeParse(payload);
    if (notice.success) notifier.notify(notice.data);
  });
  ipcMain.on(CHANNELS.setBadge, (event, payload: unknown) => {
    if (!fromApp(event)) return;
    const count = badgeSchema.safeParse(payload);
    if (count.success) app.dock?.setBadge(badgeText(count.data));
  });
  ipcMain.on(CHANNELS.listening, (event, channel: unknown) => {
    if (!fromApp(event)) return;
    if (channel === CHANNELS.navigate || channel === CHANNELS.taskDone) listening.add(channel);
  });
}

function start() {
  app.setAboutPanelOptions({
    applicationName: APP_NAME,
    applicationVersion: version,
    version: `Electron ${process.versions.electron}`,
    copyright: "Código aberto (MIT)",
  });
  // No other page may embed or open anything from the app.
  app.on("web-contents-created", (_event, contents: WebContents) => {
    contents.on("will-attach-webview", (event) => event.preventDefault());
  });
  notifier = createNotifier({
    preload: files.noticePreload,
    html: files.noticeHtml,
    onOpen: openNotice,
    onDone: finishTask,
  });
  guardSession();
  listen();
  refreshMenu();
  createWindow();

  setTimeout(() => void lookForUpdate(false), 15_000);
  setInterval(() => void lookForUpdate(false), DAY_MS);
}

app.on("before-quit", () => {
  quitting = true;
});
app.on("activate", () => showWindow());
// The app stays open without windows (reminders); only ⌘Q quits.
app.on("window-all-closed", () => {});
