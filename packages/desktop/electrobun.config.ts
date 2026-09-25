/**
 * The desktop bundle of one staged airtty application (scripts/stage.ts): a Bun main
 * process that runs the app's binary on a PTY (src/host), and one xterm.js view that
 * shows it (src/view).
 */
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { ElectrobunConfig } from "electrobun";
import { BUNDLED, STAGE, stagedApp } from "./src/staged";

// Hutch loads this file from elsewhere: the manifest is found from here, not the cwd.
const manifest = fileURLToPath(new URL(`${STAGE}/app.json`, import.meta.url));
if (!existsSync(manifest))
  throw new Error("No staged application: run `bun run stage <app directory>` first");
const app = stagedApp.parse(JSON.parse(readFileSync(manifest, "utf8")));

export default {
  app: {
    name: app.name,
    identifier: `dev.airtty.desktop.${app.name.toLowerCase().replace(/[^a-z0-9]/g, "-")}`,
    version: "0.1.0",
  },
  build: {
    // Bun, not Cottontail: the host needs Bun.Terminal (airtty/pty).
    mainProcess: "bun",
    bun: { entrypoint: "src/host/index.ts" },
    views: { terminal: { entrypoint: "src/view/index.ts" } },
    copy: {
      "src/view/index.html": "views/terminal/index.html",
      "src/view/window.css": "views/terminal/window.css",
      [`${STAGE}/app.json`]: `${BUNDLED}/app.json`,
      [`${STAGE}/bin`]: `${BUNDLED}/bin`,
    },
    // The system webview: the terminal needs nothing Chromium adds.
    mac: { bundleCEF: false },
    linux: { bundleCEF: false },
    win: { bundleCEF: false },
  },
} satisfies ElectrobunConfig;
