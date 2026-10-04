/** @jsxImportSource @opentui/react */
import { test, expect } from "bun:test";
import { act, useState, useSyncExternalStore, type ReactNode } from "react";
import { KeyEvent } from "@opentui/core";
import { useRenderer } from "@opentui/react";
import { testRender } from "@opentui/react/test-utils";
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui";
import { KeymapProvider, useBindings } from "@opentui/keymap/react";
import { Terminal } from "../packages/core/src/client";
import { legacyKey, queryResponder } from "../packages/core/src/vt/gaps";
import { WAIT_MS, destroy, execute, until, type TestUI } from "./helpers";

const key = (name: string, mods: Partial<{ ctrl: boolean; meta: boolean; shift: boolean }> = {}) =>
  new KeyEvent({
    name,
    ctrl: mods.ctrl ?? false,
    meta: mods.meta ?? false,
    shift: mods.shift ?? false,
    option: false,
    sequence: "",
    number: false,
    raw: "",
    eventType: "press",
    source: "raw",
  });

test("legacy keys the native encoder skips get xterm's sequences", () => {
  expect(legacyKey(key("f1"))).toBe("\x1bOP");
  expect(legacyKey(key("f5"))).toBe("\x1b[15~");
  expect(legacyKey(key("f5", { shift: true }))).toBe("\x1b[15;2~");
  expect(legacyKey(key("x", { meta: true }))).toBe("\x1bx");
  expect(legacyKey(key("backspace"))).toBe("\x7f");
  expect(legacyKey(key("a"))).toBe("");
});

test("device attributes and color queries are answered, even split across reads", () => {
  const respond = queryResponder({ fg: [255, 255, 255], bg: [0, 0, 0] });
  const bytes = (s: string) => new TextEncoder().encode(s);
  expect(respond(bytes("hello\x1b["))).toBe("");
  expect(respond(bytes("c"))).toBe("\x1b[?62;22c");
  expect(respond(bytes("\x1b[>c"))).toBe("\x1b[>1;10;0c");
  expect(respond(bytes("\x1b]11;?\x07"))).toBe("\x1b]11;rgb:0000/0000/0000\x07");
});

/** The keymap a Shell provides, and application bindings that must not steal keys. */
function Host({ children, hits }: { children: ReactNode; hits: Record<string, number> }) {
  const renderer = useRenderer();
  const [keymap] = useState(() => createDefaultOpenTuiKeymap(renderer));
  return (
    <KeymapProvider keymap={keymap}>
      <Bindings hits={hits} />
      {children}
    </KeymapProvider>
  );
}
function Bindings({ hits }: { hits: Record<string, number> }) {
  useBindings(() => ({
    bindings: [
      { key: "j", cmd: () => void (hits.j = (hits.j ?? 0) + 1) },
      { key: "ctrl+c", cmd: () => void (hits.quit = (hits.quit ?? 0) + 1) },
      { key: "ctrl+oo", cmd: () => void (hits.prefix = (hits.prefix ?? 0) + 1) },
    ],
  }));
  return null;
}

test("<Terminal> runs a shell: keys, host prefix, Ctrl+C, resize, exit", async () => {
  const hits: Record<string, number> = {};
  const exits: (number | null)[] = [];
  // Whether the pane has the keys, as the host's state: switched from the test.
  let active = true;
  const listeners = new Set<() => void>();
  const setActive = (next: boolean) => {
    active = next;
    for (const listener of listeners) listener();
  };
  function Pane() {
    const isActive = useSyncExternalStore(
      (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      () => active,
    );
    return (
      <Terminal
        command={["/bin/sh"]}
        env={{ PS1: "$ ", ENV: "" }}
        active={isActive}
        prefix="ctrl+o"
        flexGrow={1}
        onExit={(code) => exits.push(code)}
      />
    );
  }
  let ui: TestUI | undefined;
  const frame = () => {
    void ui?.renderOnce();
    return ui?.captureCharFrame() ?? "";
  };
  const shows = (text: string) =>
    act(async () => {
      await until(
        () => frame().includes(text),
        WAIT_MS,
        () => `waiting for ${text}:\n${frame()}`,
      );
    });
  const type = (text: string) =>
    act(async () => {
      await ui?.mockInput.typeText(text);
      ui?.mockInput.pressEnter();
    });
  try {
    ui = await testRender(
      <Host hits={hits}>
        <box flexGrow={1}>
          <Pane />
        </box>
      </Host>,
      { width: 60, height: 12 },
    );
    await shows("$ ");
    // `j` is the application's binding, yet typed into the active terminal it is text.
    await type("printf 'o%sk\\n' j");
    await shows("ojk");
    expect(hits.j).toBeUndefined();
    // The prefix sequence stays with the application.
    await act(async () => {
      ui?.mockInput.pressKey("o", { ctrl: true });
      ui?.mockInput.pressKey("o");
    });
    expect(hits.prefix).toBe(1);
    // Ctrl+C interrupts the program's foreground job and reaches no quit binding. The key
    // goes once `sleep` runs as the shell's child: a process takes that name when it execs,
    // after the shell made its group the terminal's foreground one. `pgrep -P`, as macOS's
    // pgrep has no `-s` for a session.
    await type("printf 'p%s\\n' $$");
    let shell = "";
    await act(async () => {
      await until(() => {
        shell = /^p(\d+)\s*$/m.exec(frame())?.[1] ?? "";
        return shell !== "";
      }, WAIT_MS);
    });
    await type("sleep 30");
    const sleeping = async () =>
      (await execute(["pgrep", "-x", "-P", shell, "sleep"])).stdout.toString().trim() !== "";
    await act(async () => {
      const deadline = performance.now() + WAIT_MS;
      while (!(await sleeping())) {
        if (performance.now() > deadline) throw new Error("`sleep 30` never started");
        // The step of a poll bounded by WAIT_MS: no event says another process started.
        await Bun.sleep(20);
      }
      ui?.mockInput.pressKey("c", { ctrl: true });
    });
    await type("printf 's%s\\n' $?");
    await shows("s130");
    expect(hits.quit).toBeUndefined();
    // The program follows the pane's size, which the layout gives the PTY: rendered once
    // before the program is asked, not whenever the next frame comes.
    await act(async () => {
      ui?.resize(80, 16);
      await ui?.renderOnce();
    });
    await type("stty size");
    await shows("16 80");
    // Inactive, the keys are the application's again.
    // act() applies the state change when its callback ends: press in a second one.
    await act(async () => setActive(false));
    await act(async () => ui?.mockInput.pressKey("j"));
    expect(hits.j).toBe(1);
    await act(async () => setActive(true));
    await type("exit");
    await act(async () => {
      await until(() => exits.length > 0, WAIT_MS);
    });
    expect(exits).toEqual([0]);
  } finally {
    await destroy(ui);
  }
});
