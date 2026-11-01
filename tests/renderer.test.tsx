import { renderCaptureWithoutAct } from "../packages/core/src/test/capture";
/** @jsxImportSource @opentui/react */
import { expect, test } from "bun:test";
import { Suspense, startTransition, use, useEffect, useState } from "react";
import { createTestRenderer } from "@opentui/core/testing";
import { createRoot } from "@opentui/react";
import { WAIT_MS, until } from "./helpers";

declare global {
  // Read by React to decide whether updates outside act() warn.
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

// TanStack Router commits navigations with startTransition, which act() hides.
// react-reconciler 0.34 calls a host method OpenTUI 0.6.8 lacks on such commits:
// keep the reconciler within OpenTUI's declared range until this test says otherwise.
test("OpenTUI commits React transitions with the pinned reconciler", async () => {
  const previous = globalThis.IS_REACT_ACT_ENVIRONMENT;
  globalThis.IS_REACT_ACT_ENVIRONMENT = false;
  const ui = await createTestRenderer({
    width: 20,
    height: 2,
  });
  const { renderer } = ui;
  const frame = () => renderCaptureWithoutAct(ui, ui.captureCharFrame);
  const root = createRoot(renderer);
  const handle: { update?: (value: Promise<string>) => void } = {};
  function Value() {
    const [value, setValue] = useState<string | Promise<string>>("before");
    useEffect(() => {
      handle.update = setValue;
    }, []);
    return <text>{typeof value === "string" ? value : use(value)}</text>;
  }
  const failures: unknown[] = [];
  const onError = (error: unknown) => failures.push(error);
  process.on("uncaughtException", onError);
  const log = console.error;
  console.error = (...args: unknown[]) => failures.push(args);
  try {
    root.render(
      <Suspense fallback={<text>fallback</text>}>
        <Value />
      </Suspense>,
    );
    // Waited for, not slept for: a mount or a commit takes longer on a loaded machine.
    await until(() => handle.update !== undefined, WAIT_MS);
    const update = handle.update;
    if (!update) throw new Error("Value never mounted");
    // Simulated time, not a wait: a value that resolves later suspends the transition.
    startTransition(() => update(Bun.sleep(30).then(() => "after")));
    const shows = async (text: string) => {
      return (await frame()).includes(text);
    };
    const deadline = performance.now() + WAIT_MS;
    while (!(await shows("after")) && !failures.length) {
      if (performance.now() > deadline) break;
      // The step of a poll bounded by WAIT_MS, not a wait for the outcome.
      await Bun.sleep(20);
    }
    expect(failures).toEqual([]);
    expect(await frame()).toContain("after");
  } finally {
    console.error = log;
    process.off("uncaughtException", onError);
    root.unmount();
    renderer.destroy();
    globalThis.IS_REACT_ACT_ENVIRONMENT = previous;
  }
});

// These widgets back luciole's fields; invisible content must remain editable.
test("OpenTUI inputs can delete text with no terminal cells", async () => {
  const { InputRenderable, TextareaRenderable } = await import("@opentui/core");
  const { renderer } = await createTestRenderer({ width: 20, height: 3 });
  try {
    for (const text of ["\u200b", "\u200d", "\u0301", "\u200e"]) {
      for (const Widget of [InputRenderable, TextareaRenderable]) {
        const field = new Widget(renderer, { id: "zero-width", width: 20 });
        renderer.root.add(field);
        try {
          for (const action of [
            "deleteChar",
            "deleteCharBackward",
            "deleteLine",
            "deleteSelection",
          ] as const) {
            field.setText(text);
            if (action === "deleteCharBackward") field.gotoBufferEnd();
            else field.gotoBufferHome();
            if (action === "deleteSelection") field.selectAll();
            field[action]();
            expect(field.plainText).toBe("");
          }
          if (Widget === TextareaRenderable) {
            field.setText("\u200b\n\u200fnext");
            field.gotoBufferHome();
            field.deleteLine();
            expect(field.plainText).toBe("\u200fnext");
          }
        } finally {
          field.destroy();
        }
      }
    }
  } finally {
    renderer.destroy();
  }
});
