/** @jsxImportSource @opentui/react */
import { expect, test } from "bun:test";
import { act, useEffect, useState } from "react";
import { ScrollBoxRenderable } from "@opentui/core";
import { testRender } from "@opentui/react/test-utils";
import { createRootRoute } from "@tanstack/react-router";
import {
  createApplication,
  ScrollBox,
  useRestoredFocus,
  type Application,
  type Session,
} from "../packages/core/src/client";
import { Runtime } from "../packages/core/src/runtime-context";
import { WAIT_MS, destroy, renderable, type TestUI } from "./helpers";

const ROWS = 40;
// What a late list shows at first: too few rows to reach a kept position.
const FIRST_ROWS = 8;
const LATE_MS = 200;
const FRAME_MS = 20;
// How often ScrollBox applies a kept position again (SCROLL_RETRY_MS, src/fields.tsx).
const RETRY_MS = 50;

const applicationWith = (session?: Session) =>
  createApplication({
    url: "http://127.0.0.1:1",
    buildId: "test",
    routeTree: createRootRoute(),
    resolveModule: () => ({}),
    session,
  });

let move: (name: "post/title" | "post/body") => void = () => {};
/** A form's focus, and a list whose rows arrive after it mounts (`late`), as a page's may. */
function Form({ late }: { late: boolean }) {
  const [focus, setFocus] = useRestoredFocus(["post/title", "post/body"]);
  useEffect(() => {
    move = setFocus;
  }, [setFocus]);
  const [rows, setRows] = useState(late ? FIRST_ROWS : ROWS);
  useEffect(() => {
    if (!late) return;
    const timer = setTimeout(() => setRows(ROWS), LATE_MS);
    return () => clearTimeout(timer);
  }, [late]);
  return (
    <box flexDirection="column">
      <text>{`focus:${focus}`}</text>
      <ScrollBox id="list" name="post/list" height={5}>
        {Array.from({ length: rows }, (_, i) => (
          <text key={i}>{`row ${i}`}</text>
        ))}
      </ScrollBox>
    </box>
  );
}

async function mount(app: Application, late = false) {
  let ui: TestUI | undefined;
  await act(async () => {
    ui = await testRender(
      <Runtime.Provider value={app}>
        <Form late={late} />
      </Runtime.Provider>,
      { width: 30, height: 8 },
    );
  });
  if (!ui) throw new Error("not rendered");
  const shown = ui;
  const frame = async () => {
    await act(async () => {
      await shown.renderOnce();
    });
    return shown.captureCharFrame();
  };
  return { ui: shown, frame, list: () => renderable(shown, "list", ScrollBoxRenderable) };
}

/**
 * Renders frames until `check` holds: the test renderer lays out only when asked, and the
 * list's late rows and the restore's retries are timers that fire between frames.
 */
async function untilLaidOut(
  frame: () => Promise<string>,
  check: () => boolean,
  state: () => string,
) {
  const deadline = performance.now() + WAIT_MS;
  while (!check()) {
    if (performance.now() > deadline) throw new Error(state());
    await frame();
    // The step of a poll bounded by WAIT_MS, not a wait for the outcome.
    await act(() => Bun.sleep(FRAME_MS));
  }
}

test("the focused field and the scroll position come back with the session", async () => {
  const before = applicationWith();
  const first = await mount(before);
  let second: TestUI | undefined;
  try {
    expect(await first.frame()).toContain("focus:post/title");
    await act(async () => move("post/body"));
    expect(await first.frame()).toContain("focus:post/body");
    // The user scrolls: the position is kept for this entry.
    await act(async () => {
      first.list().scrollTop = 7;
    });
    const saved = before.restoration.snapshot();
    expect(saved.entries[0]).toMatchObject({ focus: "post/body", scroll: { "post/list": 7 } });
    await destroy(first.ui);

    // The next Client: its list's rows come later, the position waits for them.
    const after = await mount(applicationWith(saved), true);
    second = after.ui;
    expect(await after.frame()).toContain("focus:post/body");
    await untilLaidOut(
      after.frame,
      () => after.list().scrollTop === 7,
      () => `scrolled to ${after.list().scrollTop}`,
    );
    expect(await after.frame()).toContain("row 7");
  } finally {
    await destroy(first.ui);
    await destroy(second);
  }
});

test("a kept focus no longer among the names gives the first one; scrolling during a restore wins", async () => {
  const app = applicationWith({
    index: 0,
    entries: [{ href: "/", fields: {}, focus: "post/gone", scroll: { "post/list": 9 } }],
  });
  const { ui, frame, list } = await mount(app, true);
  try {
    expect(await frame()).toContain("focus:post/title");
    // Before the other rows arrive, the user scrolls: the kept position is dropped.
    await frame();
    await act(async () => {
      list().scrollTop = 1;
    });
    // Kept at once: the user's scroll is recorded as it happens.
    expect(app.restoration.snapshot().entries[0]?.scroll).toEqual({ "post/list": 1 });
    // The other rows arrive and are laid out: the kept position could be reached now.
    await untilLaidOut(
      frame,
      () => list().content.getChildrenCount() === ROWS && list().scrollHeight >= ROWS,
      () => `${list().content.getChildrenCount()} rows, ${list().scrollHeight} high`,
    );
    await act(async () => {
      // A negative wait, kept: nothing marks a restore that does not happen. A retry of the
      // restore falls due within RETRY_MS, and fires before this later timer does.
      await Bun.sleep(RETRY_MS * 2);
    });
    await frame();
    expect(list().scrollTop).toBe(1);
    expect(app.restoration.snapshot().entries[0]?.scroll).toEqual({ "post/list": 1 });
  } finally {
    await destroy(ui);
  }
});
