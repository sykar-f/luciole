/** @jsxImportSource @opentui/react */
import { expect, test } from "bun:test";
import type { Fetch } from "../packages/core/src/client";
import { startForge } from "./forge-helpers";
import { privateBuild } from "./helpers";

const built = await privateBuild("examples/forge");

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
  // Every request the Client sends to the Server, as the transport hands it to `fetch`.
  const requests: string[] = [];
  const recording: Fetch = (input, init) => {
    requests.push(input.pathname);
    return fetch(input, init);
  };
  const forge = await startForge(built, {
    latencyMs: RTT,
    fetch: recording,
    env: { FORGE_SLOW_MS: "0" },
  });
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
    await forge.settle();
  };
  try {
    await forge.signIn("alice");
    await forge.preloaded(); // the first row's preload completes
    const idle = await metrics();
    const sent = requests.length;

    // Filter, hover and wheel: the frames are local, zero requests. The frame showing
    // the filter's result is the proof it needed no answer, however slow the machine.
    await step(() => ui.mockInput.typeText("/"));
    await step(() => ui.mockInput.typeText("settle"));
    let shown = await frame();
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
    await forge.quietFor(RTT + 100);
    expect(await metrics()).toEqual(idle);
    expect(requests.length).toBe(sent);

    // The selected row was preloaded while idle: Enter shows it without a round-trip,
    // so the frame has the page and no request left for it.
    await step(() => ui.mockInput.pressEnter());
    shown = await frame();
    expect(forge.path()).toBe("/repos/web/pulls/1");
    expect(shown).toContain("#1 Dark mode design tokens");
    await forge.settle();
    expect((await metrics()).renders).toBe(idle.renders);
    expect(requests.length).toBe(sent);

    // Not preloaded: the local loading screen appears at once, in the final geometry.
    const start = performance.now();
    await step(() => ui.mockInput.pressTab());
    shown = await frame();
    expect(shown).toContain("loading files");
    expect(shown).toContain("Files"); // the persistent tab bar is still there
    const loading = geometry();
    await forge.waitFor("src/theme.ts");
    expect(performance.now() - start).toBeGreaterThanOrEqual(RTT * 0.9);
    expect(geometry()).toEqual(loading);
  } finally {
    await forge.stop();
  }
}, 60000);
