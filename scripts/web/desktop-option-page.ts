/** The desktop view's terminal options (packages/desktop/src/settings.ts) on xterm.js. */
import { Terminal } from "@xterm/xterm";
import {
  applySettings,
  BEFORE_SETTINGS,
  type WindowSettings,
} from "../../packages/desktop/src/settings";

const terminal = new Terminal({ ...BEFORE_SETTINGS });
terminal.open(document.body);
const sent: string[] = [];
terminal.onData((data) => sent.push(data));
terminal.focus();
Object.assign(globalThis, {
  desktopOption: {
    /** What the terminal sent since the last call. */
    take: () => sent.splice(0).join(""),
    apply: (settings: WindowSettings) => applySettings(terminal, settings),
  },
});
