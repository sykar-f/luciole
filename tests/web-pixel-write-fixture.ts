// Bundled against patched OpenTUI and WASM, with only the page UI substituted.
import { expect, spyOn, test } from "bun:test";
import { runInPage } from "../packages/core/src/web/platform/run";
import { createApp, state } from "./web-pixel-page-stubs";

Object.assign(globalThis, {
  addEventListener() {},
  ResizeObserver: class {
    observe() {}
  },
  requestAnimationFrame() {},
});
async function page() {
  state.chunks.length = 0;
  await runInPage(createApp, {
    // eslint-disable-next-line typescript/consistent-type-assertions -- UI substitutes never inspect the element.
    element: {} as HTMLElement,
    server: new URL("http://localhost"),
    name: "pixel-write",
    restore: false,
    pixelScroll: true,
  });
  const session = state.session;
  if (!session) throw new Error("No page output session");
  return session;
}

test("page pixel commands wait for the complete split frame to drain", async () => {
  const session = await page();
  const first = Promise.withResolvers<void>();
  const bytes = (text: string) => new TextEncoder().encode(text);
  const parts = ["\x1b[?2026h", "A".repeat(Number(session.maxAtomicWriteBytes)), "\x1b[?2026l"];
  let draining: Promise<void> | undefined;
  try {
    await session.beginFrameOutput();
    for (const part of parts) {
      expect(session.write(bytes(part))).toBe(true);
      await session.idle();
    }
    state.hold = true;
    state.reached = first.resolve;
    const frame = session.endFrameOutput(true);
    draining = frame;
    await first.promise;
    state.write("PIXEL-CONTROL");
    // The page attachment returns void; session.idle alone is not its reservation.
    // Queue a sentinel through the same ordered writer so completion is explicit.
    expect(state.chunks.join("")).not.toContain("PIXEL-CONTROL");
    const sentinel = session.writeControl(bytes("SENTINEL"));
    state.resume();
    await Promise.all([frame, sentinel]);
    expect(state.chunks.length).toBeGreaterThan(3);
    expect(state.chunks.join("")).toBe(parts.join("") + "PIXEL-CONTROLSENTINEL");
  } finally {
    state.hold = false;
    state.resume();
    await draining;
    await session.close();
  }
});

test("page reports a rejected control write without an unhandled rejection", async () => {
  state.reject = true;
  const session = await page();
  const messages: unknown[] = [];
  const errors = spyOn(console, "error").mockImplementation((message: unknown) => {
    messages.push(message);
  });
  try {
    state.write("PIXEL-CONTROL");
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(messages).toEqual(["page control write rejected"]);
    // bun:test also fails the isolated process on any unhandled rejection.
  } finally {
    errors.mockRestore();
    state.reject = false;
    await session.close();
  }
});

test("page keeps terminal.write when the ordered writer is absent", async () => {
  state.missing = true;
  const session = await page();
  try {
    state.write("FALLBACK");
    expect(state.chunks).toEqual(["FALLBACK"]);
  } finally {
    state.missing = false;
    await session.close();
  }
});

for (const [search, option, attached] of [
  ["", undefined, false],
  ["?pixel-scroll", undefined, true],
  ["?pixel-scroll", false, false],
  ["", true, true],
] as const) {
  test(`web pixel precedence: ${search || "no flag"}, code ${String(option)}`, async () => {
    location.search = search;
    const before = state.attached;
    await runInPage(createApp, {
      // eslint-disable-next-line typescript/consistent-type-assertions -- UI substitutes never inspect the element.
      element: {} as HTMLElement,
      server: new URL("http://localhost"),
      name: "pixel-precedence",
      restore: false,
      ...(option === undefined ? {} : { pixelScroll: option }),
    });
    try {
      expect(state.attached - before).toBe(attached ? 1 : 0);
    } finally {
      await state.session?.close();
      location.search = "";
    }
  });
}
