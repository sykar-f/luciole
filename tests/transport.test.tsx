/** @jsxImportSource @opentui/react */
import { test, expect } from "bun:test";
import { act } from "react";
import { testRender } from "@opentui/react/test-utils";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { z } from "zod";
import { build } from "../packages/core/src/build";
import {
  WAIT_MS,
  launch,
  privateBuild,
  until,
  wire,
  importClient,
  destroy,
  draftOf,
  markdownEditor,
  temporaryApp,
  type TestUI,
} from "./helpers";
const built = await privateBuild("examples/notes");
// What Notes' `saveNote` answers (examples/notes/components/draft.ts): nothing more.
const SaveResult = z.discriminatedUnion("ok", [
  z.strictObject({
    ok: z.literal(true),
    note: z.strictObject({
      id: z.string(),
      title: z.string(),
      value: z.string(),
      version: z.number(),
      updated: z.number(),
    }),
    operationId: z.string(),
  }),
  z.strictObject({
    ok: z.literal(false),
    error: z.string(),
    operationId: z.string(),
    conflict: z.optional(z.boolean()),
  }),
]);
const count = (db: Database) =>
  db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM operations").get()?.n;
test("lost commit: durable outcome recovery, no mutation replay, reconnect refresh", async () => {
  const dir = await mkdtemp(join(tmpdir(), "luciole-loss-"));
  const dbPath = join(dir, "notes.sqlite");
  let server = await launch(join(built.output, "server/index.js"), {
    NOTES_DB: dbPath,
    LUCIOLE_TEST_DROP_ONCE: "1",
    NOTES_AUTOSAVE_MS: "0",
  });
  const { createApp, Shell } = await importClient(built.directory, "loss");
  const app = createApp({ url: server.url, initialPath: "/notes/1" });
  const requests = wire(app);
  let rendered: TestUI | undefined;
  try {
    await app.router.load();
    const ui = await testRender(<Shell app={app} />, { width: 100, height: 24 });
    rendered = ui;
    // Return edits the note shown; Ctrl+S saves it.
    await act(async () => {
      ui.mockInput.pressEnter();
    });
    const seed = markdownEditor(ui, "note-1").value;
    await act(async () => {
      await ui.mockInput.typeText("abc");
    });
    await act(async () => {
      ui.mockInput.pressKey("s", { ctrl: true });
    });
    const draft = draftOf(app, "1");
    await act(async () => {
      await until(() => draft.unknown);
    });
    const operationId = draft.pending?.operationId;
    await until(() => server.child.exitCode !== null);
    const previousPid = server.pid;
    server = await launch(join(built.output, "server/index.js"), {
      NOTES_DB: dbPath,
      PORT: String(server.port),
      NOTES_AUTOSAVE_MS: "0",
    });
    expect(server.pid).not.toBe(previousPid);
    await act(async () => {
      await ui.mockInput.typeText("d");
    });
    expect(draft.value).toBe(`${seed}abcd`);
    const db = new Database(dbPath, { readonly: true });
    expect(
      db
        .query<{ value: string; version: number }, [string]>(
          "SELECT value,version FROM notes WHERE id=?",
        )
        .get("1"),
    ).toEqual({
      value: `${seed}abc`,
      version: 2,
    });
    expect(count(db)).toBe(1);
    await act(async () => {
      await app.refresh();
    });
    // The outcome is looked up by itself once the Server is back: no one has to ask. On a
    // loaded machine the lookup may already be through when the refresh above ends.
    await act(async () => {
      await until(() => !draft.pending, WAIT_MS);
      // The refresh and the lookup have both answered: the state below is final.
      await requests.settled();
    });
    expect(draft.baseline).toBe(`${seed}abc`);
    expect(draft.value).toBe(`${seed}abcd`);
    expect(draft.version).toBe(2);
    expect(draft.unknown).toBe(false);
    // One operation stored, the lost one: resolving it looked it up, never replayed it.
    expect(count(db)).toBe(1);
    db.close();
    expect(operationId).toBeDefined();
    expect(app.status).toBe("Connected");
  } finally {
    await act(() => requests.settled().catch(() => {}));
    await destroy(rendered);
    await server.stop();
    await rm(dir, { recursive: true, force: true });
  }
});
test("out-of-order navigation, incompatible build preserves mounted editor, refresh failure after save", async () => {
  const dir = await mkdtemp(join(tmpdir(), "luciole-network-"));
  const server = await launch(join(built.output, "server/index.js"), {
    NOTES_DB: join(dir, "notes.sqlite"),
    NOTES_AUTOSAVE_MS: "0",
  });
  const { createApp, Shell } = await importClient(built.directory, "network");
  let slow = false,
    block = false,
    incompatible = false;
  const app = createApp({
    url: server.url,
    initialPath: "/notes/1",
    fetch: async (input: URL, init: RequestInit) => {
      const url = String(input);
      if (incompatible) return new Response("Incompatible build", { status: 409 });
      // The refresh after the save fails, and so does the sidebar's list read beside it.
      const listing = new Headers(init.headers).get("x-luciole-action")?.endsWith("#listNotes");
      if (block && (url.includes("/render") || listing))
        throw new Error("network unavailable during refresh");
      // Simulated time, not a wait: note 1 answers late, after the navigation past it.
      if (slow && new URL(url).searchParams.get("params") === '{"id":"1"}') await Bun.sleep(350);
      return fetch(input, init);
    },
  });
  const requests = wire(app);
  let rendered: TestUI | undefined;
  try {
    await app.router.load();
    const ui = await testRender(<Shell app={app} />, { width: 100, height: 24 });
    rendered = ui;
    await act(async () => {
      ui.mockInput.pressEnter();
    });
    const seed = markdownEditor(ui, "note-1").value;
    await act(async () => {
      await ui.mockInput.typeText("abc");
    });
    block = true;
    await act(async () => {
      ui.mockInput.pressKey("s", { ctrl: true });
    });
    const draft = draftOf(app, "1");
    await act(async () => {
      await until(() => !draft.pending);
      await until(() => app.status === "Disconnected");
    });
    expect(draft.baseline).toBe(`${seed}abc`);
    expect(draft.unknown).toBe(false);
    expect(draft.dirty).toBe(false);
    block = false;
    slow = true;
    await act(async () => {
      app.router.clearCache();
      await Promise.all([
        app.router.navigate({ to: "/" }),
        app.router.navigate({ to: "/notes/1" }),
        app.router.navigate({ to: "/notes/2" }),
      ]);
      // Every response is in, the slow one for note 1 included: none is left to land.
      await requests.settled();
    });
    await ui.renderOnce();
    // The latest navigation wins; the slower superseded response never replaces it.
    expect(app.router.state.resolvedLocation?.pathname).toBe("/notes/2");
    const field = markdownEditor(ui, "note-2");
    const other = field.value;
    await act(async () => {
      ui.mockInput.pressEnter();
    });
    await act(async () => {
      await ui.mockInput.typeText("keep");
    });
    incompatible = true;
    await act(async () => {
      await app.refresh();
    });
    expect(app.status).toBe("Incompatible build");
    expect(ui.renderer.root.findDescendantById("note-2")).toBe(field.node);
    expect(field.value).toBe(`${other}keep`);
    await act(async () => {
      await ui.mockInput.typeText("!");
    });
    expect(field.value).toBe(`${other}keep!`);
    const bad = await fetch(server.url + "/render?route=%2F&params=%7B%7D", {
      headers: { "x-luciole-build": "old" },
    });
    expect(bad.status).toBe(409);
    // A body the Server cannot decode: with the current build it fails at decoding, with
    // an old one the build check refuses it first.
    const undecodable = (build: string) =>
      fetch(server.url + "/action", {
        method: "POST",
        headers: {
          "x-luciole-build": build,
          "x-luciole-action": `${server.buildId}/actions/notes.ts#saveNote`,
        },
        body: "{not flight",
      });
    expect((await undecodable(server.buildId)).status).toBe(500);
    expect((await undecodable("old")).status).toBe(409);
  } finally {
    await act(() => requests.settled().catch(() => {}));
    await destroy(rendered);
    await server.stop();
    await rm(dir, { recursive: true, force: true });
  }
});
test("progressive Flight Suspense renders fallback before delayed content", async () => {
  const dir = await temporaryApp("stream");
  // The Suspense boundary resolves once the test creates this file, not after a delay: the
  // fallback stays on screen for as long as the test looks at it.
  const release = join(dir, "release");
  let server: Awaited<ReturnType<typeof launch>> | undefined,
    rendered: TestUI | undefined,
    requests: ReturnType<typeof wire> | undefined;
  try {
    await mkdir(join(dir, "app"), { recursive: true });
    await Bun.write(
      join(dir, "app/layout.tsx"),
      `"use client";export default function Layout({children}){return <box flexDirection="column">{children}</box>}`,
    );
    await Bun.write(
      join(dir, "app/page.tsx"),
      `import {Suspense} from 'react';async function Slow(){while(!(await Bun.file(${JSON.stringify(release)}).exists()))await Bun.sleep(10);return <text>STREAM COMPLETE</text>}export default function Page(){return <box flexDirection="column"><text>SHELL READY</text><Suspense fallback={<text>STREAM LOADING</text>}><Slow/></Suspense></box>}`,
    );
    await build(dir);
    server = await launch(join(dir, ".luciole/server/index.js"));
    const { createApp, Shell } = await importClient(dir);
    const app = createApp({ url: server.url });
    requests = wire(app);
    await app.router.load();
    const ui = await testRender(<Shell app={app} />, { width: 80, height: 12 });
    rendered = ui;
    await ui.renderOnce();
    expect(ui.captureCharFrame()).toContain("STREAM LOADING");
    expect(ui.captureCharFrame()).toContain("SHELL READY");
    await Bun.write(release, "");
    // One act() per step: the Suspense retry commits when an act() ends, not within one.
    const deadline = performance.now() + WAIT_MS;
    while (!ui.captureCharFrame().includes("STREAM COMPLETE")) {
      if (performance.now() > deadline) throw new Error("The streamed content never rendered");
      // The step of a poll bounded by WAIT_MS, not a wait for the outcome.
      await act(() => Bun.sleep(10));
      await ui.renderOnce();
    }
    expect(ui.captureCharFrame()).not.toContain("STREAM LOADING");
  } finally {
    // The page stream ends once released, should a check above have failed first.
    await Bun.write(release, "");
    await act(async () => requests?.settled().catch(() => {}));
    await destroy(rendered);
    if (server) await server.stop();
    await rm(dir, { recursive: true, force: true });
  }
});
test("Notes validation, normalization, version conflict, durable deduplication and authentication", async () => {
  const dir = await mkdtemp(join(tmpdir(), "luciole-business-"));
  const server = await launch(join(built.output, "server/index.js"), {
    NOTES_DB: join(dir, "notes.sqlite"),
    LUCIOLE_TOKEN: "test-session-token",
  });
  const { createApp } = await importClient(built.directory, "business");
  const app = createApp({ url: server.url, token: "test-session-token" });
  try {
    expect((await fetch(server.url + "/health")).status).toBe(401);
    expect(
      (
        await fetch(server.url + "/health", {
          headers: {
            authorization: "Bearer test-session-token",
            origin: "https://other.invalid",
          },
        })
      ).status,
    ).toBe(403);
    const save = async (snapshot: unknown) =>
      SaveResult.parse(
        await app.callServer(`${server.buildId}/actions/notes.ts#saveNote`, [snapshot]),
      );
    const snapshot = {
      id: "1",
      value: "x".repeat(20_001),
      version: 1,
      revision: 0,
      operationId: crypto.randomUUID(),
    };
    expect((await save(snapshot)).ok).toBe(false);
    // Leading spaces are Markdown (an indented block); trailing ones are dropped.
    const valid = {
      ...snapshot,
      value: " abc \n\n",
      operationId: crypto.randomUUID(),
    };
    const result = await save(valid);
    expect(result.ok).toBe(true);
    const note = result.ok ? result.note : undefined;
    expect(note?.value).toBe(" abc");
    expect(note?.version).toBe(2);
    expect(await save(valid)).toEqual(result);
    const conflict = await save({
      ...valid,
      value: "new",
      operationId: crypto.randomUUID(),
    });
    expect(conflict.ok).toBe(false);
    expect(conflict.ok ? false : conflict.conflict).toBe(true);
  } finally {
    await server.stop();
    await rm(dir, { recursive: true, force: true });
  }
});
