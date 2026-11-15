// Bundles main and the two preloads with esbuild (CommonJS for Electron), so
// the packaged app needs no node_modules, and copies the static pages.
import { build } from "esbuild";
import { cpSync, mkdirSync, rmSync } from "node:fs";

const common = {
  bundle: true,
  sourcemap: true,
  logLevel: "warning",
  platform: "node",
  format: "cjs",
  external: ["electron"],
};
rmSync("dist", { recursive: true, force: true });
mkdirSync("dist", { recursive: true });
await Promise.all([
  build({ ...common, entryPoints: ["src/main/index.ts"], outfile: "dist/main.js", target: "node22" }),
  // Sandboxed preloads: Chromium, not Node.
  build({ ...common, entryPoints: ["src/preload/index.ts"], outfile: "dist/preload.js", target: "chrome140" }),
  build({ ...common, entryPoints: ["src/preload/aviso.ts"], outfile: "dist/aviso-preload.js", target: "chrome140" }),
]);
cpSync("static", "dist/static", { recursive: true });
console.log("build pronto em dist/");
