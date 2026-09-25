/** @jsxImportSource @opentui/react */
import { beforeAll, expect, test } from "bun:test";
import { build } from "../packages/airtty/src/build";
import { forgeDirectory, startForge } from "./forge-helpers";

beforeAll(async () => {
  await build(forgeDirectory);
}, 60000);

const RTT = 500;
const FRAME_IDS = [
  "screen-title",
  "screen-subtitle",
  "screen-body",
  "screen-status",
  "screen-help",
  "pull-tabs",
];

test("under 500 ms RTT: local interactions stay local, preload removes the wait, loading keeps geometry", async () => {
  const forge = await startForge({ latencyMs: RTT, env: { FORGE_SLOW_MS: "0" } });
  const { ui, step, frame, metrics } = forge;
  const geometry = () =>
    Object.fromEntries(
      FRAME_IDS.map((id) => {
        const node = ui.renderer.root.findDescendantById(id);
        return [id, node ? [node.x, node.y, node.width, node.height] : null];
      }),
    );
  // A lone ESC is only recognised after a pause, as in a real terminal: ESC followed at
  // once by "/" is Alt+/.
  const escape = async () => {
    await step(() => ui.mockInput.pressEscape());
    await forge.settle(80);
  };
  try {
    await forge.signIn("alice");
    await forge.settle(1500); // the first row's preload completes
    const idle = await metrics();

    // Filter, hover and wheel: immediate frames, zero requests.
    let start = performance.now();
    await step(() => ui.mockInput.typeText("/"));
    await step(() => ui.mockInput.typeText("settle"));
    let shown = await frame();
    expect(performance.now() - start).toBeLessThan(RTT / 2);
    expect(shown).toContain("Stream settlement reports");
    expect(shown).not.toContain("Add idempotency keys");
    await escape();
    await step(() => ui.mockInput.typeText("/"));
    await step(() => {
      for (let i = 0; i < 6; i++) ui.mockInput.pressBackspace();
    });
    await escape();
    const row = ui.renderer.root.findDescendantById("pull-row-payments-1");
    if (!row) throw new Error("pull request row missing");
    await step(() => ui.mockMouse.moveTo(row.x + 20, row.y));
    const list = ui.renderer.root.findDescendantById("pull-list");
    if (!list) throw new Error("pull request list missing");
    await step(() => ui.mockMouse.scroll(list.x + 5, list.y + 1, "down"));
    await forge.settle(RTT + 100);
    expect(await metrics()).toEqual(idle);

    // The selected row was preloaded while idle: Enter shows it without a round-trip.
    start = performance.now();
    await step(() => ui.mockInput.pressEnter());
    shown = await frame();
    const openMs = performance.now() - start;
    expect(forge.path()).toBe("/repos/web/pulls/1");
    expect(shown).toContain("#1 Dark mode design tokens");
    expect(openMs).toBeLessThan(RTT / 2);
    await forge.settle(RTT + 200);
    expect((await metrics()).renders).toBe(idle.renders);

    // Not preloaded: the local loading screen appears at once, in the final geometry.
    start = performance.now();
    await step(() => ui.mockInput.pressTab());
    shown = await frame();
    expect(performance.now() - start).toBeLessThan(RTT / 2);
    expect(shown).toContain("loading files");
    expect(shown).toContain("Files"); // the persistent tab bar is still there
    const loading = geometry();
    await forge.waitFor("src/theme.ts", 3000);
    expect(performance.now() - start).toBeGreaterThanOrEqual(RTT * 0.9);
    expect(geometry()).toEqual(loading);
  } finally {
    await forge.stop();
  }
}, 60000);
