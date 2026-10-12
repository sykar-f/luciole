/** @jsxImportSource @opentui/react */
import { expect, test } from "bun:test";
import { act, StrictMode, useEffect, useState } from "react";
import { createRootRoute } from "@tanstack/react-router";
import { testRender } from "@opentui/react/test-utils";
import { Application, Shell, useLive, type LiveState } from "../packages/core/src/client";
import { destroy, untilFrame } from "./helpers";

test("useLive folds exactly once under StrictMode, retains no items and resets on new arguments", async () => {
  const failure = new Error("reducer failed");
  let change = (_attempt: number) => {};
  let calls = 0;
  const snapshots: { state: number; done: boolean; error: unknown }[] = [];
  async function* source(attempt: number) {
    for (let item = 1; item <= 8; item++) yield item;
    if (attempt === 1) throw new Error("source failed");
  }
  function Screen() {
    const [attempt, setAttempt] = useState(0);
    useEffect(() => {
      change = setAttempt;
    }, []);
    const live = useLive(source, [attempt], {
      initial: 10,
      reduce: (sum, item) => {
        calls++;
        if (attempt === 2) throw failure;
        return sum + item;
      },
    });
    snapshots.push(live);
    expect(Object.hasOwn(live, "items")).toBe(false);
    return <text>{`${attempt}:${live.state}:${live.done}:${String(live.error)}`}</text>;
  }
  const app = new Application({
    url: "http://127.0.0.1:1",
    buildId: "reduce-test",
    resolveModule: () => ({}),
    routeTree: createRootRoute({ component: Screen }),
  });
  await app.router.load();
  const ui = await testRender(
    <StrictMode>
      <Shell app={app} />
    </StrictMode>,
    { width: 80, height: 5 },
  );
  try {
    await untilFrame(ui, "0:46:true:undefined");
    expect(calls).toBe(8);
    expect(snapshots.every((snapshot) => !Object.hasOwn(snapshot, "items"))).toBe(true);
    await act(async () => change(1));
    await untilFrame(ui, "1:46:true:Error: source failed");
    expect(calls).toBe(16);
    expect(snapshots.some((snapshot) => snapshot.state === 10 && !snapshot.done)).toBe(true);
    await act(async () => change(2));
    await untilFrame(ui, "2:10:true:Error: reducer failed");
    expect(calls).toBe(17);
    expect(snapshots.at(-1)?.error).toBe(failure);
  } finally {
    await destroy(ui);
  }
});

for (const limit of [3, 0, -2, 2.5, NaN, Infinity]) {
  test(`useLive preserves array snapshots and slice semantics for limit ${limit}`, async () => {
    const snapshots: LiveState<number>[] = [];
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    async function* source() {
      yield 1;
      await gate;
      for (let item = 2; item <= 8; item++) yield item;
    }
    function Screen() {
      const live = useLive(source, [], { limit });
      snapshots.push(live);
      return <text>{`${live.items.join(",")}:${live.done}`}</text>;
    }
    const app = new Application({
      url: "http://127.0.0.1:1",
      buildId: "array-test",
      resolveModule: () => ({}),
      routeTree: createRootRoute({ component: Screen }),
    });
    await app.router.load();
    const ui = await testRender(<Shell app={app} />, { width: 80, height: 5 });
    try {
      await untilFrame(ui, `${[1].slice(-limit).join(",")}:false`);
      const first = snapshots.at(-1)?.items;
      await act(async () => release());
      let expected: number[] = [];
      for (let item = 1; item <= 8; item++) expected = [...expected, item].slice(-limit);
      await untilFrame(ui, `${expected.join(",")}:true`);
      expect(snapshots.at(-1)?.items).toEqual(expected);
      expect(first).toEqual([1].slice(-limit));
    } finally {
      release();
      await destroy(ui);
    }
  });
}
