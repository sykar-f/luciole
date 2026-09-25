/**
 * The desktop bundle of one staged airtty application (scripts/stage.ts): a Bun main
 * process that runs the app's binary on a PTY (src/host), and one xterm.js view that
 * shows it (src/view). Named, versioned and decorated from the app's own metadata
 * (`airtty` of its package.json, airtty/metadata).
 */
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { ElectrobunConfig } from "electrobun";
import { BUNDLED, ICON_PNG, ICONSET, METADATA, STAGE, readMetadata } from "./src/staged";

// Hutch loads this file from elsewhere: the stage is found from here, not the cwd.
const staged = (file: string) => fileURLToPath(new URL(`${STAGE}/${file}`, import.meta.url));
if (!existsSync(staged(METADATA)))
  throw new Error("No staged application: run `bun run stage <app directory>` first");
const app = readMetadata(readFileSync(staged(METADATA), "utf8"));
const icon = app.icon ? `${STAGE}/${ICON_PNG}` : undefined;
const iconset = existsSync(staged(ICONSET)) ? `${STAGE}/${ICONSET}` : undefined;

export default {
  app: {
    name: app.displayName,
    // Declared by the application, or one of its own under a namespace no one else uses.
    identifier:
      app.identifier ?? `dev.airtty.desktop.${app.name.toLowerCase().replace(/[^a-z0-9]/g, "-")}`,
    version: app.version ?? "0.0.0",
    description: app.description,
  },
  build: {
    // Bun, the runtime airtty/pty is written and tested for, and the one the app binary
    // already carries. Cottontail, the default, has Bun.Terminal too but is no smaller.
    mainProcess: "bun",
    bun: { entrypoint: "src/host/index.ts" },
    views: { terminal: { entrypoint: "src/view/index.ts" } },
    copy: {
      "src/view/index.html": "views/terminal/index.html",
      "src/view/window.css": "views/terminal/window.css",
      [`${STAGE}/${METADATA}`]: `${BUNDLED}/${METADATA}`,
      [`${STAGE}/bin`]: `${BUNDLED}/bin`,
    },
    // The system webview: the terminal needs nothing Chromium adds.
    mac: { bundleCEF: false, ...(iconset && { icons: iconset }) },
    linux: { bundleCEF: false, ...(icon && { icon }) },
    win: { bundleCEF: false, ...(icon && { icon }) },
  },
} satisfies ElectrobunConfig;
