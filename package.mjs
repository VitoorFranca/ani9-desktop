// Builds release/ANI-9-<versão>-macos-arm64.dmg (and the .app inside release/).
// Signing:
//   default            ad-hoc signature: macOS asks to confirm the first time,
//                      notifications go to the app's own panel, no auto-update
//   SIGN_IDENTITY=...  Developer ID + hardened runtime
//   + APPLE_ID, APPLE_APP_PASSWORD, APPLE_TEAM_ID  notarized and stapled
import { FuseV1Options, FuseVersion, flipFuses } from "@electron/fuses";
import { packager } from "@electron/packager";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const APP_NAME = "ANI-9";
const BUNDLE_ID = "online.ani9.desktop"; // permanent: macOS ties permissions to it
const { version } = JSON.parse(readFileSync("package.json", "utf8"));

execFileSync("node", ["build.mjs"], { stdio: "inherit" });

const identity = process.env.SIGN_IDENTITY || null;
const notarize =
  identity && process.env.APPLE_ID && process.env.APPLE_APP_PASSWORD && process.env.APPLE_TEAM_ID
    ? {
        appleId: process.env.APPLE_ID,
        appleIdPassword: process.env.APPLE_APP_PASSWORD,
        teamId: process.env.APPLE_TEAM_ID,
      }
    : undefined;

const [appDir] = await packager({
  dir: ".",
  out: "release",
  overwrite: true,
  platform: "darwin",
  arch: "arm64",
  name: APP_NAME,
  appBundleId: BUNDLE_ID,
  appVersion: version,
  icon: "build/macos/icon.icns",
  appCategoryType: "public.app-category.education",
  asar: true,
  // Fuses flipped on the fresh Electron, before any signature: the app binary
  // cannot be run as a plain Node or receive Node options from the environment.
  afterExtract: [
    ({ buildPath }) =>
      flipFuses(join(buildPath, "Electron.app"), {
        version: FuseVersion.V1,
        [FuseV1Options.RunAsNode]: false,
        [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
        [FuseV1Options.EnableNodeCliInspectArguments]: false,
        [FuseV1Options.OnlyLoadAppFromAsar]: true,
      }),
  ],
  prune: true,
  // Everything the app runs is bundled by esbuild into dist/.
  ignore: [
    /^\/(src|build|release|tests|static|node_modules|\.github)(\/|$)/,
    /\.(ts|map|md)$/,
    /^\/(tsconfig\.json|build\.mjs|package\.mjs|pnpm-lock\.yaml)$/,
  ],
  ...(identity
    ? {
        osxSign: {
          identity,
          optionsForFile: () => ({ hardenedRuntime: true, entitlements: "build/macos/entitlements.plist" }),
        },
        osxNotarize: notarize,
      }
    : {}),
  extendInfo: {
    LSMinimumSystemVersion: "26.0",
    NSHumanReadableCopyright: "Código aberto (MIT)",
  },
});

const app = join(appDir, `${APP_NAME}.app`);
if (!identity) {
  execFileSync("codesign", ["--force", "--deep", "--sign", "-", app], { stdio: "inherit" });
}
execFileSync("codesign", ["--verify", "--deep", "--strict", app], { stdio: "inherit" });

// The disk image: the app and a shortcut to Aplicativos, to drag one onto the other.
const dmg = join("release", `${APP_NAME}-${version}-macos-arm64.dmg`);
const stage = mkdtempSync(join(tmpdir(), "ani9-dmg-"));
cpSync(app, join(stage, `${APP_NAME}.app`), { recursive: true, verbatimSymlinks: true });
symlinkSync("/Applications", join(stage, "Aplicativos"));
rmSync(dmg, { force: true });
execFileSync(
  "hdiutil",
  ["create", "-volname", APP_NAME, "-srcfolder", stage, "-fs", "HFS+", "-format", "UDZO", "-ov", dmg],
  {
    stdio: "inherit",
  },
);
rmSync(stage, { recursive: true, force: true });
console.log(`pronto (${identity ? `Developer ID${notarize ? ", notarizado" : ""}` : "ad-hoc"}):\n${app}\n${dmg}`);
