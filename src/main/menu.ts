// The macOS menu bar, in Portuguese, with the standard shortcuts. Without the
// Editar menu, copy and paste would not work in the window.

import { Menu, type MenuItemConstructorOptions } from "electron";

export const SCREENS: { label: string; path: string; key: string }[] = [
  { label: "Início", path: "/", key: "1" },
  { label: "Baralhos", path: "/decks", key: "2" },
  { label: "Cartões", path: "/browse", key: "3" },
  { label: "Roadmaps", path: "/roadmaps", key: "4" },
  { label: "Cadernos", path: "/notebooks", key: "5" },
  { label: "Rotina", path: "/rotina", key: "6" },
  { label: "Foco", path: "/foco", key: "7" },
  { label: "Estatísticas", path: "/stats", key: "8" },
];

export interface MenuActions {
  appName: string;
  devTools: boolean;
  openAtLogin: boolean;
  /** A newer release, when one was found. */
  update: { version: string } | null;
  go: (path: string) => void;
  back: () => void;
  forward: () => void;
  checkForUpdates: () => void;
  downloadUpdate: () => void;
  setOpenAtLogin: (on: boolean) => void;
  openWebsite: () => void;
  openReleases: () => void;
  openSource: () => void;
}

export function menuTemplate(actions: MenuActions): MenuItemConstructorOptions[] {
  const app: MenuItemConstructorOptions = {
    label: actions.appName,
    submenu: [
      { role: "about", label: `Sobre o ${actions.appName}` },
      { type: "separator" },
      { label: "Procurar atualizações…", click: actions.checkForUpdates },
      ...(actions.update
        ? [{ label: `Baixar a versão ${actions.update.version}…`, click: actions.downloadUpdate }]
        : []),
      { type: "separator" },
      {
        label: "Abrir ao iniciar sessão",
        type: "checkbox",
        checked: actions.openAtLogin,
        click: (item) => actions.setOpenAtLogin(item.checked),
      },
      { label: "Configurações…", accelerator: "Cmd+,", click: () => actions.go("/settings") },
      { type: "separator" },
      { role: "services", label: "Serviços" },
      { type: "separator" },
      { role: "hide", label: `Ocultar ${actions.appName}` },
      { role: "hideOthers", label: "Ocultar os demais" },
      { role: "unhide", label: "Mostrar tudo" },
      { type: "separator" },
      { role: "quit", label: `Sair do ${actions.appName}` },
    ],
  };
  const edit: MenuItemConstructorOptions = {
    label: "Editar",
    submenu: [
      { role: "undo", label: "Desfazer" },
      { role: "redo", label: "Refazer" },
      { type: "separator" },
      { role: "cut", label: "Recortar" },
      { role: "copy", label: "Copiar" },
      { role: "paste", label: "Colar" },
      { role: "pasteAndMatchStyle", label: "Colar sem formatação" },
      { role: "delete", label: "Apagar" },
      { role: "selectAll", label: "Selecionar tudo" },
    ],
  };
  const view: MenuItemConstructorOptions = {
    label: "Visualizar",
    submenu: [
      { role: "reload", label: "Recarregar" },
      ...(actions.devTools ? [{ role: "toggleDevTools" as const, label: "Ferramentas de desenvolvimento" }] : []),
      { type: "separator" },
      { role: "resetZoom", label: "Tamanho real" },
      { role: "zoomIn", label: "Aumentar" },
      { role: "zoomOut", label: "Diminuir" },
      { type: "separator" },
      { role: "togglefullscreen", label: "Tela cheia" },
    ],
  };
  const go: MenuItemConstructorOptions = {
    label: "Ir",
    submenu: [
      { label: "Voltar", accelerator: "Cmd+[", click: actions.back },
      { label: "Avançar", accelerator: "Cmd+]", click: actions.forward },
      { type: "separator" },
      ...SCREENS.map((screen): MenuItemConstructorOptions => ({
        label: screen.label,
        accelerator: `Cmd+${screen.key}`,
        click: () => actions.go(screen.path),
      })),
    ],
  };
  const window: MenuItemConstructorOptions = {
    role: "windowMenu",
    label: "Janela",
    submenu: [
      { role: "minimize", label: "Minimizar" },
      { role: "zoom", label: "Zoom" },
      { role: "close", label: "Fechar janela" },
      { type: "separator" },
      { role: "front", label: "Trazer tudo para a frente" },
    ],
  };
  const help: MenuItemConstructorOptions = {
    role: "help",
    label: "Ajuda",
    submenu: [
      { label: `Site do ${actions.appName}`, click: actions.openWebsite },
      { label: "Versões do app desktop", click: actions.openReleases },
      { label: "Código do app desktop", click: actions.openSource },
    ],
  };
  return [app, edit, view, go, window, help];
}

export function buildMenu(actions: MenuActions): Menu {
  return Menu.buildFromTemplate(menuTemplate(actions));
}
