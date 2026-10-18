/** Drawer animations belong to one renderer and can be cleaned up after it closes. */
import { expect, test } from "bun:test";
import { act, useState } from "react";
import { ManualClock } from "@opentui/core/testing";
import { testRender } from "@opentui/react/test-utils";
import { Drawer } from "../examples/notes/components/Drawer";

const DURATION_MS = 200;
test("two Notes drawers animate independently and close safely mid-animation", async () => {
  const toggles: (() => void)[] = [];
  function Panel() {
    const [open, setOpen] = useState(true);
    toggles.push(() => setOpen(false));
    return (
      <Drawer open={open} width={20} railWidth={2} rail={<text>R</text>}>
        <text>Drawer content</text>
      </Drawer>
    );
  }
  const firstClock = new ManualClock();
  const secondClock = new ManualClock();
  const first = await testRender(<Panel />, { width: 30, height: 4, clock: firstClock });
  const second = await testRender(<Panel />, { width: 30, height: 4, clock: secondClock });
  try {
    await act(async () => {
      toggles[0]?.();
    });
    // Closing one renderer while its slide runs must not attach another timeline
    // engine during the React effect's cleanup.
    await act(async () => {
      await first.dispose();
    });
    await second.renderOnce();
    expect(second.captureCharFrame()).toContain("Drawer content");
    await act(async () => {
      toggles[1]?.();
    });
    await act(async () => {
      secondClock.advance(DURATION_MS);
      await second.renderOnce();
    });
    expect(second.captureCharFrame()).toContain("R");
    expect(second.captureCharFrame()).not.toContain("Drawer content");
  } finally {
    await act(async () => {
      await first.dispose();
      await second.dispose();
    });
  }
});
