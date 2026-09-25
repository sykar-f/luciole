/**
 * The desktop host: one window, the staged application's binary on a PTY behind it
 * (./session.ts). The window is the application: closing it, or quitting, hangs the
 * PTY up, and the program's end closes the window, which ends the host.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ApplicationMenu, BrowserView, BrowserWindow, PATHS, app } from "electrobun/main";
import type { TerminalRPC } from "../protocol";
import { BUNDLED, METADATA, readMetadata } from "../staged";
import { createWindowSession } from "./session";

const bundled = join(PATHS.RESOURCES_FOLDER, "app", BUNDLED);
const { name, displayName } = readMetadata(readFileSync(join(bundled, METADATA), "utf8"));

const session = createWindowSession({
  command: [join(bundled, "bin", name)],
  // Started from the Finder, the host's directory is the bundle's: the user's home is
  // what a terminal would open in.
  cwd: homedir(),
  send: (data) => mainWindow.webview.rpc?.send.output({ data }),
  onExit: () => mainWindow.close(),
});
const rpc = BrowserView.defineRPC<TerminalRPC>({
  handlers: {
    messages: {
      open: (size) => session.open(size),
      input: ({ data, binary }) => session.input(data, binary),
      resize: (size) => session.resize(size),
    },
  },
});
const mainWindow = new BrowserWindow({
  title: displayName,
  url: "views://terminal/index.html",
  frame: { width: 1000, height: 680 },
  rpc,
});
mainWindow.on("close", () => session.hangUp());
app.on("before-quit", () => session.hangUp());

// The standard menus: Cmd+Q and Cmd+W end the application through the window, Cmd+C
// and Cmd+V copy the view's selection and paste into the program. Ctrl+C stays a key.
// Roles give no key equivalent of their own: each is set (Command on macOS, Control
// elsewhere).
ApplicationMenu.setApplicationMenu([
  {
    submenu: [
      { role: "about" },
      { type: "divider" },
      { role: "hide", accelerator: "h" },
      { role: "hideOthers" },
      { role: "showAll" },
      { type: "divider" },
      { role: "quit", accelerator: "q" },
    ],
  },
  {
    label: "Edit",
    submenu: [
      { role: "copy", accelerator: "c" },
      { role: "paste", accelerator: "v" },
      { role: "selectAll", accelerator: "a" },
    ],
  },
  {
    label: "Window",
    submenu: [
      { role: "minimize", accelerator: "m" },
      { role: "zoom" },
      { role: "toggleFullScreen" },
      { type: "divider" },
      { role: "close", accelerator: "w" },
    ],
  },
]);
