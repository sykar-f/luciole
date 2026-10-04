/** @jsxImportSource @opentui/react */
import { expect, test } from "bun:test";
import { act } from "react";
import { testRender } from "@opentui/react/test-utils";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Application, Session } from "../packages/core/src/client";
import {
  destroy,
  draftOf,
  importClient,
  launch,
  markdownEditor,
  privateBuild,
  until,
  type TestUI,
} from "./helpers";

const built = await privateBuild("examples/notes");
const fieldsAt = (app: Application, href: string) =>
  app.restoration.snapshot().entries.find((e) => e.href === href)?.fields;

test("a named field comes back after a restart, is forgotten once sent, kept if never sent", async () => {
  const folder = await mkdtemp(join(tmpdir(), "luciole-restore-"));
  const server = await launch(join(built.output, "server/index.js"), {
    NOTES_DB: join(folder, "notes.sqlite"),
    // Saves only when asked: what is kept or forgotten follows the test's own saves.
    NOTES_AUTOSAVE_MS: "0",
  });
  let refuse = false;
  const open = async (tag: string, session?: Session) => {
    const { createApp, Shell } = await importClient(built.directory, tag);
    const app = createApp({
      url: server.url,
      session,
      // Saves only: a refused connection is `not-sent`, the Server ran nothing.
      fetch: async (input, init) => {
        if (refuse && init?.method === "POST")
          throw Object.assign(new Error("Connection refused"), { code: "ECONNREFUSED" });
        return fetch(input, init);
      },
    });
    await app.router.load();
    const ui = await testRender(<Shell app={app} />, { width: 100, height: 24 });
    return { app, ui };
  };
  let first: TestUI | undefined, second: TestUI | undefined;
  try {
    const before = await open("restore-before");
    first = before.ui;
    await act(async () => {
      await before.app.router.navigate({ to: "/notes/$id", params: { id: "1" } });
    });
    // Return, with nothing being typed, edits the note shown.
    await act(async () => {
      before.ui.mockInput.pressEnter();
    });
    const seed = markdownEditor(before.ui, "note-1").value;
    await act(async () => {
      await before.ui.mockInput.typeText("abc");
    });
    expect(fieldsAt(before.app, "/notes/1")).toEqual({ "note/text": `${seed}abc` });
    const saved = before.app.restoration.snapshot();
    // The Client dies: its memory (Drafts included) is gone, the session file is not.
    await destroy(first);
    first = undefined;

    const after = await open("restore-after", saved);
    second = after.ui;
    const { app, ui } = after;
    expect(app.router.state.resolvedLocation?.pathname).toBe("/notes/1");
    await act(async () => {
      await until(() => markdownEditor(ui, "note-1").value === `${seed}abc`);
    });
    // Restored text is unsaved work: it went through the editor like typing.
    expect(draftOf(app, "1").dirty).toBe(true);
    // Back still leads to the list the user came from.
    expect(app.restoration.snapshot().entries.map((e) => e.href)).toEqual(["/", "/notes/1"]);

    // Never sent: the text is kept for the next start.
    refuse = true;
    await act(async () => {
      ui.mockInput.pressKey("s", { ctrl: true });
      await until(() => draftOf(app, "1").error !== "");
    });
    expect(draftOf(app, "1").error).toContain("Not saved");
    expect(fieldsAt(app, "/notes/1")).toEqual({ "note/text": `${seed}abc` });

    // Sent and committed: nothing is offered again after a crash.
    refuse = false;
    await act(async () => {
      ui.mockInput.pressKey("s", { ctrl: true });
      await until(() => !draftOf(app, "1").pending && !draftOf(app, "1").dirty);
    });
    expect(fieldsAt(app, "/notes/1")).toEqual({});

    // The first bearer keeps typed text (a sign-in after a crash); replacing it forgets it.
    // Typing needs the text in hand again: Ctrl+E puts the cursor back at its end.
    await act(async () => {
      ui.mockInput.pressKey("e", { ctrl: true });
    });
    await act(async () => {
      await ui.mockInput.typeText("d");
    });
    expect(fieldsAt(app, "/notes/1")).toEqual({ "note/text": `${seed}abcd` });
    app.setToken("first");
    expect(fieldsAt(app, "/notes/1")).toEqual({ "note/text": `${seed}abcd` });
    app.setToken(undefined);
    expect(fieldsAt(app, "/notes/1")).toEqual({});
  } finally {
    await destroy(first);
    await destroy(second);
    await server.stop();
    await rm(folder, { recursive: true, force: true });
  }
}, 30000);
