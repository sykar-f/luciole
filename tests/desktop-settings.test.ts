/**
 * The window's settings (packages/desktop/src/settings.ts): from the application's
 * metadata to the view's terminal options, sent by the session before the program starts.
 */
import { expect, test } from "bun:test";
import { createWindowSession } from "../packages/desktop/src/host/session";
import { applySettings, BEFORE_SETTINGS, windowSettings } from "../packages/desktop/src/settings";
import { until } from "./helpers";

const metadata = { format: 1 as const, name: "notes", displayName: "Notes" };

for (const [desktop, macOptionIsMeta] of [
  [undefined, true],
  [{}, true],
  [{ macOptionIsMeta: false }, false],
] as const) {
  test(`the view's Option is Meta: ${macOptionIsMeta}, for ${JSON.stringify(desktop)}`, async () => {
    const view: { options: { macOptionIsMeta?: boolean; disableStdin?: boolean } } = {
      options: { ...BEFORE_SETTINGS },
    };
    // What the view's options were when the program first wrote.
    let atFirstOutput: typeof view.options | undefined;
    let exit: number | null | undefined;
    let configured = 0;
    const session = createWindowSession({
      command: ["/bin/sh", "-c", "echo started"],
      configure: () => {
        configured++;
        applySettings(view, windowSettings({ ...metadata, desktop }));
      },
      send: () => {
        atFirstOutput ??= { ...view.options };
      },
      onExit: (code) => {
        exit = code;
      },
    });
    expect(view.options).toEqual({ macOptionIsMeta: true, disableStdin: true });
    session.open({ cols: 40, rows: 10 });
    session.open({ cols: 40, rows: 10 });
    await until(() => exit !== undefined);
    expect(configured).toBe(1);
    expect(atFirstOutput).toEqual({ macOptionIsMeta, disableStdin: false });
  });
}
