/** @jsxImportSource @opentui/react */
import { expect, test } from "bun:test";
import { Suspense, startTransition, use, useEffect, useState } from "react";
import { createTestRenderer } from "@opentui/core/testing";
import { createRoot } from "@opentui/react";

// TanStack Router commits navigations with startTransition, which act() hides.
// react-reconciler 0.34 calls a host method OpenTUI 0.5.12 lacks on such commits:
// keep the reconciler within OpenTUI's declared range until this test says otherwise.
test("OpenTUI commits React transitions with the pinned reconciler", async () => {
  const previous = (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
  const { renderer, renderOnce, captureCharFrame } = await createTestRenderer({
    width: 20,
    height: 2,
  });
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
    await Bun.sleep(30);
    startTransition(() => handle.update!(Bun.sleep(30).then(() => "after")));
    await Bun.sleep(400);
    await renderOnce();
    expect(failures).toEqual([]);
    expect(captureCharFrame()).toContain("after");
  } finally {
    console.error = log;
    process.off("uncaughtException", onError);
    root.unmount();
    renderer.destroy();
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = previous;
  }
});
