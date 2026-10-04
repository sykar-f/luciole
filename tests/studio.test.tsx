/** @jsxImportSource @opentui/react */
/**
 * studio end to end, offline: its real Server on the scripted generator, its generated
 * Client in OpenTUI's test renderer, the preview's Client on a real PTY (sandboxed where
 * this system can). A prompt becomes a revision running in the preview; a build that
 * fails and a page that fails in the preview go back to the generator, which corrects
 * them; Ctrl+O u undoes; nothing outlives the studio.
 */
import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { act } from "react";
import { testRender } from "@opentui/react/test-utils";
import { isolationProblem } from "../examples/studio/server/preview";
import { eventually, execute, importClient, launch, privateBuild, WAIT_MS } from "./helpers";

const built = await privateBuild("examples/studio");
const MODE = isolationProblem("sandbox") ? "process" : "sandbox";
const WIDTH = 160;
// Tall enough for a failure and its correction to stay on screen together: on a loaded
// machine both can happen between two frames, so the test reads the failure afterwards.
const HEIGHT = 120;
const STEP_TIMEOUT_MS = 60_000;

async function startStudio(mode: string = MODE) {
  const temp = realpathSync(await mkdtemp(join(tmpdir(), "studio-e2e-")));
  // The preview's Client keeps its sessions under the Client's state: this test's.
  const state = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = join(temp, "state");
  const project = join(temp, "demo");
  const server = await launch(join(built.output, "server/index.js"), {
    LUCIOLE_ARGS: JSON.stringify({
      v: 1,
      argv: ["--harness", "fake", "--dir", project, "--preview", mode],
      cwd: temp,
    }),
    XDG_STATE_HOME: join(temp, "state"),
    STUDIO_FAKE_DELAY_MS: "1",
  });
  const { createApp, Shell } = await importClient(built.directory, crypto.randomUUID());
  const app = createApp({ url: server.url, latencyMs: 0 });
  await app.router.load();
  const ui = await testRender(<Shell app={app} />, { width: WIDTH, height: HEIGHT });
  const frame = async () => {
    await ui.renderOnce();
    return ui.captureCharFrame();
  };
  const step = (work: () => unknown) =>
    act(async () => {
      await work();
    });
  const waitFor = async (check: string | RegExp, timeout = STEP_TIMEOUT_MS) => {
    const start = performance.now();
    for (;;) {
      // The poll of a wait on the frame, bounded by `timeout`: the app works meanwhile.
      await step(() => Bun.sleep(50));
      const shown = await frame();
      if (typeof check === "string" ? shown.includes(check) : check.test(shown)) return shown;
      if (performance.now() - start > timeout)
        throw new Error(`Frame never showed ${String(check)}:\n${shown}`);
    }
  };
  const prompt = async (text: string) => {
    await step(() => ui.mockInput.typeText(text));
    // The composer holds the text it submits.
    await waitFor(text);
    await step(() => ui.mockInput.pressKey("RETURN"));
  };
  const press = (key: string, modifiers?: { ctrl?: boolean }) =>
    step(() => ui.mockInput.pressKey(key, modifiers));
  return {
    project,
    frame,
    waitFor,
    prompt,
    press,
    stop: async () => {
      await act(async () => ui.renderer.destroy());
      app.dispose();
      await server.stop();
      // The preview's processes leave with the studio; on a loaded machine, not at once.
      // Still there past the guard, the test's last check names them.
      await eventually(async () => (await leftovers(project)).length === 0, WAIT_MS).catch(
        () => {},
      );
      if (state === undefined) delete process.env.XDG_STATE_HOME;
      else process.env.XDG_STATE_HOME = state;
      await rm(temp, { recursive: true, force: true });
    },
  };
}

/** Processes still running from the project (the preview's Server or Client). */
const leftovers = async (project: string) =>
  (await execute(["pgrep", "-f", project])).stdout.toString().split(/\s+/).filter(Boolean);

test(`studio (${MODE}): a prompt runs as a revision, failures are corrected, Ctrl+O u undoes`, async () => {
  const studio = await startStudio();
  try {
    // r0, the template, runs in the preview as soon as studio opens.
    await studio.waitFor("describe the app you want");
    await studio.waitFor(/r0 · (sandbox|process)/);

    await studio.prompt("Add a /todos page with a list I can move through");
    await studio.waitFor("Revision r1 built and running.");
    await studio.waitFor(/ r1 · (sandbox|process) /);

    // A syntax error: the build fails, studio says where, the generator corrects it.
    await studio.prompt("Show the count in bold");
    const corrected = await studio.waitFor("Revision r2 built and running.");
    expect(corrected).toMatch(/The build failed[^]*app\/page\.tsx:\d+[^]*Revision r2 built/);

    // A page that throws in the preview: its Client reports it, studio corrects it.
    await studio.prompt("Show the todo count in the list");
    const recovered = await studio.waitFor("Revision r4 built and running.");
    expect(recovered).toMatch(/A page failed in the preview[^]*Revision r4 built/);
    await studio.waitFor("2 todos");

    // Ctrl+O u: back to r3's files, as a new revision.
    await studio.press("o", { ctrl: true });
    await studio.press("u");
    await studio.waitFor(/ r5 · (sandbox|process) /);
    await studio.press("o", { ctrl: true });
    await studio.press("h");
    await studio.waitFor("r5 · restored");
  } finally {
    await studio.stop();
  }
  expect(await leftovers(studio.project)).toEqual([]);
}, 300_000);

test("studio --preview process: the app runs with the user's rights, and says so; /allow is a revision", async () => {
  const studio = await startStudio("process");
  try {
    await studio.waitFor("describe the app you want");
    await studio.waitFor("Preview not isolated: the generated app runs with your rights");
    await studio.waitFor(/ r0 · process /);
    await studio.prompt("/allow api.example.com");
    await studio.waitFor(/ r1 · process /);
    const manifest: unknown = await Bun.file(join(studio.project, "package.json")).json();
    expect(manifest).toMatchObject({ luciole: { capabilities: { net: ["api.example.com"] } } });
    await studio.press("o", { ctrl: true });
    await studio.press("h");
    await studio.waitFor("r1 · network: api.example.com");
  } finally {
    await studio.stop();
  }
  expect(await leftovers(studio.project)).toEqual([]);
}, 120_000);
