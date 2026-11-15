import { describe, expect, it, vi } from "vitest";
vi.mock("electron", () => ({ Menu: { buildFromTemplate: (t: unknown) => t } }));
import { SCREENS, menuTemplate } from "../src/main/menu.js";

const actions = {
  appName: "ANI-9",
  devTools: false,
  openAtLogin: false,
  update: null,
  go: vi.fn(),
  back: vi.fn(),
  forward: vi.fn(),
  checkForUpdates: vi.fn(),
  downloadUpdate: vi.fn(),
  setOpenAtLogin: vi.fn(),
  openWebsite: vi.fn(),
  openReleases: vi.fn(),
  openSource: vi.fn(),
};

type Item = { label?: string; role?: string; accelerator?: string; submenu?: Item[]; click?: () => void };

describe("menu", () => {
  it("has the edit roles copy and paste need, in Portuguese", () => {
    const edit = (menuTemplate(actions) as Item[]).find((m) => m.label === "Editar")!;
    expect(edit.submenu!.map((i) => i.role)).toEqual(
      expect.arrayContaining(["undo", "redo", "cut", "copy", "paste", "selectAll"]),
    );
  });

  it("gives every screen its own shortcut and opens it", () => {
    const go = (menuTemplate(actions) as Item[]).find((m) => m.label === "Ir")!;
    const keys = go.submenu!.map((i) => i.accelerator).filter(Boolean);
    expect(new Set(keys).size).toBe(keys.length);
    go.submenu!.find((i) => i.label === "Rotina")!.click!();
    expect(actions.go).toHaveBeenCalledWith("/rotina");
    expect(SCREENS.every((s) => s.path.startsWith("/"))).toBe(true);
  });

  it("offers the download only when a newer version exists, and dev tools only in development", () => {
    const labels = (template: Item[]) => template.flatMap((m) => (m.submenu ?? []).map((i) => i.label ?? i.role));
    expect(labels(menuTemplate(actions) as Item[])).not.toContain("Baixar a versão 0.2.0…");
    expect(labels(menuTemplate({ ...actions, update: { version: "0.2.0" } }) as Item[])).toContain(
      "Baixar a versão 0.2.0…",
    );
    expect(labels(menuTemplate(actions) as Item[])).not.toContain("Ferramentas de desenvolvimento");
  });
});
