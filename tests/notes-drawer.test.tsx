/** Drawer animations belong to one renderer and can be cleaned up after it closes. */
import { expect, test } from "bun:test";
import { act, useEffect, useState } from "react";
import { getTimelineEngine } from "@opentui/core";
import { testRender } from "@opentui/react/test-utils";
import { Drawer } from "../examples/notes/components/Drawer";

const DURATION_MS = 200;
test("two Notes drawers animate independently and close safely mid-animation", async () => {
  const toggles: (() => void)[] = [];
  function Panel({ slot }: { slot: number }) {
    const [open, setOpen] = useState(true);
    useEffect(() => {
      toggles[slot] = () => setOpen(false);
    }, [slot]);
    return (
      <Drawer open={open} width={20} railWidth={2} rail={<text>R</text>}>
        <text>Drawer content</text>
      </Drawer>
    );
  }
  const first = await testRender(<Panel slot={0} />, { width: 30, height: 4 });
  const second = await testRender(<Panel slot={1} />, { width: 30, height: 4 });
  try {
    await act(async () => {
      toggles[0]?.();
    });
    // Closing one renderer while its slide runs must not attach another timeline
    // engine during the React effect's cleanup.
    await act(async () => {
      await first.dispose();
    });
    // OpenTUI test-utils clears this process-global flag when any renderer closes.
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
    await second.renderOnce();
    expect(second.captureCharFrame()).toContain("Drawer content");
    await act(async () => {
      toggles[1]?.();
    });
    await act(async () => {
      getTimelineEngine(second.renderer).update(DURATION_MS);
    });
    await second.renderOnce();
    expect(second.captureCharFrame()).toContain("R");
    expect(second.captureCharFrame()).not.toContain("Drawer content");
  } finally {
    await act(async () => {
      await first.dispose();
      await second.dispose();
    });
  }
});
