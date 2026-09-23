/** @jsxImportSource @opentui/react */
import { test, expect } from "bun:test";
import { act } from "react";
import { testRender } from "@opentui/react/test-utils";
import { InputRenderable } from "@opentui/core";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Database } from "bun:sqlite";
import { z } from "zod";
import { build } from "../src/build";
import {
  launch,
  until,
  importClient,
  destroy,
  draftOf,
  metricsOf,
  renderable,
  type TestUI,
} from "./helpers";
const root = resolve("examples/notes");
// What Notes' `saveNote` answers (examples/notes/components/draft.ts): nothing more.
const SaveResult = z.discriminatedUnion("ok", [
  z.strictObject({
    ok: z.literal(true),
    note: z.strictObject({
      id: z.string(),
      title: z.string(),
      value: z.string(),
      version: z.number(),
    }),
    operationId: z.string(),
  }),
  z.strictObject({ ok: z.literal(false), error: z.string(), operationId: z.string() }),
]);
const count = (db: Database) =>
  db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM operations").get()?.n;
test("lost commit: durable outcome recovery, no mutation replay, reconnect refresh", async () => {
  await build(root);
  const dir = await mkdtemp(join(tmpdir(), "airtty-loss-"));
  const dbPath = join(dir, "notes.sqlite");
  let server = await launch(join(root, ".airtty/server/index.js"), {
    NOTES_DB: dbPath,
    AIRTTY_TEST_DROP_ONCE: "1",
  });
  const { createApp, Shell } = await importClient(root, "loss");
  const app = createApp({ url: server.url, initialPath: "/notes/1" });
  let rendered: TestUI | undefined;
  try {
    await app.router.load();
    const ui = await testRender(<Shell app={app} />, { width: 100, height: 24 });
    rendered = ui;
    await act(async () => {
      await ui.mockInput.typeText("abc");
    });
    await act(async () => {
      ui.mockInput.pressEnter();
    });
    const draft = draftOf(app, "1");
    await act(async () => {
      await until(() => draft.unknown);
    });
    const operationId = draft.pending?.operationId;
    await until(() => server.child.exitCode !== null);
    const previousPid = server.pid;
    server = await launch(join(root, ".airtty/server/index.js"), {
      NOTES_DB: dbPath,
      PORT: String(server.port),
    });
    expect(server.pid).not.toBe(previousPid);
    await act(async () => {
      await ui.mockInput.typeText("d");
    });
    expect(draft.value).toBe("abcd");
    const db = new Database(dbPath, { readonly: true });
    expect(
      db
        .query<{ value: string; version: number }, [string]>(
          "SELECT value,version FROM notes WHERE id=?",
        )
        .get("1"),
    ).toEqual({
      value: "abc",
      version: 2,
    });
    expect(count(db)).toBe(1);
    await act(async () => {
      await app.refresh();
    });
    expect(draft.unknown).toBe(true);
    await act(async () => {
      ui.mockInput.pressKey("o", { ctrl: true });
    });
    await act(async () => {
      await until(() => !draft.pending);
      await Bun.sleep(30);
    });
    expect(draft.baseline).toBe("abc");
    expect(draft.value).toBe("abcd");
    expect(draft.version).toBe(2);
    expect(draft.unknown).toBe(false);
    expect(count(db)).toBe(1);
    db.close();
    const metrics = await metricsOf(server);
    expect(metrics.actions).toBe(1); // only the lookup in the restarted process; no save replay
    expect(operationId).toBeDefined();
    expect(app.status).toBe("Connected");
  } finally {
    await destroy(rendered);
    await server.stop();
    await rm(dir, { recursive: true, force: true });
  }
});
test("out-of-order navigation, incompatible build preserves mounted editor, refresh failure after save", async () => {
  await build(root);
  const dir = await mkdtemp(join(tmpdir(), "airtty-network-"));
  const server = await launch(join(root, ".airtty/server/index.js"), {
    NOTES_DB: join(dir, "notes.sqlite"),
  });
  const { createApp, Shell } = await importClient(root, "network");
  let slow = false,
    block = false,
    incompatible = false;
  const app = createApp({
    url: server.url,
    initialPath: "/notes/1",
    fetch: async (input: URL, init: RequestInit) => {
      const url = String(input);
      if (incompatible) return new Response("Incompatible build", { status: 409 });
      if (block && url.includes("/render")) throw new Error("network unavailable during refresh");
      if (slow && new URL(url).searchParams.get("params") === '{"id":"1"}') await Bun.sleep(350);
      return fetch(input, init);
    },
  });
  let rendered: TestUI | undefined;
  try {
    await app.router.load();
    const ui = await testRender(<Shell app={app} />, { width: 100, height: 24 });
    rendered = ui;
    await act(async () => {
      await ui.mockInput.typeText("abc");
    });
    block = true;
    await act(async () => {
      ui.mockInput.pressEnter();
    });
    const draft = draftOf(app, "1");
    await act(async () => {
      await until(() => !draft.pending);
      await until(() => app.status === "Disconnected");
    });
    expect(draft.baseline).toBe("abc");
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
      await Bun.sleep(400);
    });
    // The latest navigation wins; the slower superseded response never replaces it.
    expect(app.router.state.resolvedLocation?.pathname).toBe("/notes/2");
    const field = renderable(ui, "note-2", InputRenderable);
    await act(async () => {
      await ui.mockInput.typeText("keep");
    });
    incompatible = true;
    await act(async () => {
      await app.refresh();
    });
    expect(app.status).toBe("Incompatible build");
    expect(ui.renderer.root.findDescendantById("note-2")).toBe(field);
    expect(field.value).toBe("keep");
    await act(async () => {
      await ui.mockInput.typeText("!");
    });
    expect(field.value).toBe("keep!");
    const bad = await fetch(server.url + "/render?route=%2F&params=%7B%7D", {
      headers: { "x-airtty-build": "old" },
    });
    expect(bad.status).toBe(409);
  } finally {
    await destroy(rendered);
    await server.stop();
    await rm(dir, { recursive: true, force: true });
  }
});
test("progressive Flight Suspense renders fallback before delayed content", async () => {
  const dir = await mkdtemp(join(root, "../../.stream-test-"));
  let server: Awaited<ReturnType<typeof launch>> | undefined, rendered: TestUI | undefined;
  try {
    await mkdir(join(dir, "app"), { recursive: true });
    await Bun.write(
      join(dir, "app/layout.tsx"),
      `"use client";export default function Layout({children}){return <box flexDirection="column">{children}</box>}`,
    );
    await Bun.write(
      join(dir, "app/page.tsx"),
      `import {Suspense} from 'react';async function Slow(){await Bun.sleep(700);return <text>STREAM COMPLETE</text>}export default function Page(){return <box flexDirection="column"><text>SHELL READY</text><Suspense fallback={<text>STREAM LOADING</text>}><Slow/></Suspense></box>}`,
    );
    await build(dir);
    server = await launch(join(dir, ".airtty/server/index.js"));
    const { createApp, Shell } = await importClient(dir);
    const app = createApp({ url: server.url });
    await app.router.load();
    const ui = await testRender(<Shell app={app} />, { width: 80, height: 12 });
    rendered = ui;
    await ui.renderOnce();
    expect(ui.captureCharFrame()).toContain("STREAM LOADING");
    expect(ui.captureCharFrame()).toContain("SHELL READY");
    await act(async () => {
      await Bun.sleep(800);
    });
    await ui.renderOnce();
    expect(ui.captureCharFrame()).toContain("STREAM COMPLETE");
    expect(ui.captureCharFrame()).not.toContain("STREAM LOADING");
  } finally {
    await destroy(rendered);
    if (server) await server.stop();
    await rm(dir, { recursive: true, force: true });
  }
});
test("Notes validation, normalization, version conflict, durable deduplication and authentication", async () => {
  await build(root);
  const dir = await mkdtemp(join(tmpdir(), "airtty-business-"));
  const server = await launch(join(root, ".airtty/server/index.js"), {
    NOTES_DB: join(dir, "notes.sqlite"),
    AIRTTY_TOKEN: "test-session-token",
  });
  const { createApp } = await importClient(root, "business");
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
      value: "",
      version: 1,
      revision: 0,
      operationId: crypto.randomUUID(),
    };
    expect((await save(snapshot)).ok).toBe(false);
    const valid = {
      ...snapshot,
      value: " abc ",
      operationId: crypto.randomUUID(),
    };
    const result = await save(valid);
    expect(result.ok).toBe(true);
    const note = result.ok ? result.note : undefined;
    expect(note?.value).toBe("abc");
    expect(note?.version).toBe(2);
    expect(await save(valid)).toEqual(result);
    const conflict = await save({
      ...valid,
      value: "new",
      operationId: crypto.randomUUID(),
    });
    expect(conflict.ok).toBe(false);
    expect(conflict.ok ? "" : conflict.error).toContain("conflict");
  } finally {
    await server.stop();
    await rm(dir, { recursive: true, force: true });
  }
});
