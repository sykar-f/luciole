/** @jsxImportSource @opentui/react */
/** The React caller must also pass terminal signals to a direct program. */
import { expect, test } from "bun:test";
import { act, useState, type ReactNode } from "react";
import { useRenderer } from "@opentui/react";
import { testRender } from "@opentui/react/test-utils";
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui";
import { KeymapProvider } from "@opentui/keymap/react";
import { Terminal } from "../packages/core/src/vt/terminal";
import { eventually, WAIT_MS } from "./helpers";

function Host({ children }: { children: ReactNode }) {
  const renderer = useRenderer();
  const [keymap] = useState(() => createDefaultOpenTuiKeymap(renderer));
  return <KeymapProvider keymap={keymap}>{children}</KeymapProvider>;
}

test("a direct program in Terminal receives kernel resize and Ctrl+C", async () => {
  const program = `process.on('SIGWINCH',()=>setTimeout(()=>console.log('SIZE '+process.stdout.columns+'x'+process.stdout.rows),0));process.on('SIGINT',()=>console.log('SIGINT'));console.log('READY');setInterval(()=>{},1000)`;
  const ui = await testRender(
    <Host>
      <Terminal command={[process.execPath, "-e", program]} active flexGrow={1} />
    </Host>,
    { width: 80, height: 24 },
  );
  const shows = async (text: string) =>
    act(async () => {
      await eventually(
        async () => {
          await ui.renderOnce();
          return ui.captureCharFrame().includes(text);
        },
        WAIT_MS,
        () => ui.captureCharFrame(),
      );
    });
  try {
    await shows("READY");
    await act(async () => {
      ui.resize(120, 40);
      await ui.renderOnce();
    });
    await shows("SIZE 120x40");
    await act(async () => {
      ui.mockInput.pressKey("c", { ctrl: true });
    });
    await shows("SIGINT");
    expect(ui.captureCharFrame()).toContain("SIGINT");
  } finally {
    await act(async () => {
      await ui.dispose();
    });
  }
});
