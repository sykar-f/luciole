/** @jsxImportSource @opentui/react */
import { expect, test } from "bun:test";
import { act, type ReactNode } from "react";
import type { ProgramStatus as Report } from "@opentui/core";
import { createRoot } from "@opentui/react";
import { createTestRenderer } from "@opentui/core/testing";
import { useProgramStatus, type ProgramStatus } from "../packages/core/src/client";
import { ProgramStatusScope } from "../packages/core/src/program-status";

function Reporter({ status }: { status: ProgramStatus }) {
  useProgramStatus({ app: "test-app", title: "Test" }, status);
  return null;
}

async function mount(node: ReactNode, reports: Report[]) {
  const ui = await createTestRenderer({ width: 20, height: 3 });
  ui.renderer.setProgramStatus = (status) => {
    reports.push(status);
    return true;
  };
  const root = createRoot(ui.renderer);
  await act(async () => root.render(node));
  return { ...ui, rerender: (next: ReactNode) => root.render(next) };
}

test("state changes replace metadata, explicit clear only carries its address", async () => {
  const reports: Report[] = [];
  const tree = (status: ProgramStatus) => <Reporter status={status} />;
  const ui = await mount(tree({ state: "working", id: "task" }), reports);
  try {
    await act(async () => {});
    await act(async () =>
      ui.rerender(tree({ state: "blocked", id: "task", kind: "permission", message: "Allow?" })),
    );
    await act(async () => ui.rerender(tree({ state: "done", id: "task" })));
    await act(async () => ui.rerender(tree({ state: "clear", id: "task" })));
    expect(reports).toEqual([
      { state: "working", id: "task", app: "test-app", title: "Test" },
      {
        state: "blocked",
        id: "task",
        kind: "permission",
        message: "Allow?",
        app: "test-app",
        title: "Test",
      },
      { state: "done", id: "task", app: "test-app", title: "Test" },
      { state: "clear", id: "task" },
    ]);
  } finally {
    await act(async () => ui.renderer.destroy());
  }
});

test("panes have distinct records and clear their records when removed", async () => {
  const reports: Report[] = [];
  const ui = await mount(
    <>
      <ProgramStatusScope>
        <Reporter status={{ state: "done" }} />
      </ProgramStatusScope>
      <ProgramStatusScope>
        <Reporter status={{ state: "blocked", kind: "permission", message: "Allow?" }} />
      </ProgramStatusScope>
    </>,
    reports,
  );
  await act(async () => {});
  const [done, blocked] = reports;
  expect(done?.id).toMatch(/^pane-/);
  expect(blocked?.id).toMatch(/^pane-/);
  expect(done?.id).not.toBe(blocked?.id);
  await act(async () => ui.rerender(null));
  expect(reports).toContainEqual({ state: "clear", id: done?.id });
  expect(reports).toContainEqual({ state: "clear", id: blocked?.id });
  await act(async () => ui.renderer.destroy());
});

test("standalone completion survives unmount; active work is cleared", async () => {
  for (const state of ["done", "error", "working", "blocked"] as const) {
    const reports: Report[] = [];
    const status: ProgramStatus =
      state === "blocked" ? { state, kind: "permission", message: "Allow?" } : { state };
    const ui = await mount(<Reporter status={status} />, reports);
    await act(async () => {});
    await act(async () => ui.rerender(null));
    expect(reports.at(-1)?.state).toBe(state === "done" || state === "error" ? state : "clear");
    await act(async () => ui.renderer.destroy());
  }
});

test("browser runtime sends no terminal reports", async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", { value: {}, configurable: true });
  const reports: Report[] = [];
  try {
    const ui = await mount(<Reporter status={{ state: "working" }} />, reports);
    await act(async () => ui.rerender(null));
    await act(async () => ui.renderer.destroy());
    expect(reports).toEqual([]);
  } finally {
    if (descriptor) Object.defineProperty(globalThis, "document", descriptor);
    else Reflect.deleteProperty(globalThis, "document");
  }
});
