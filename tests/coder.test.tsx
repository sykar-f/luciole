/** @jsxImportSource @opentui/react */
import { beforeAll, expect, test } from "bun:test";
import { build } from "../packages/core/src/build";
import { SCRIPTED } from "../packages/harness/src/ui/StatusLine";
import { DEMO_END, DEMO_PROMPT } from "../packages/harness/src/adapters/fake";
import { coderDirectory, startCoder } from "./coder-helpers";

beforeAll(async () => {
  await build(coderDirectory);
}, 60000);

test("a prompt streams a Markdown reply; the status line tells model, mode and harness", async () => {
  const coder = await startCoder();
  try {
    await coder.waitFor("scripted demo is ready");
    const ready = await coder.frame();
    expect(ready).toContain("fake-large · medium");
    expect(ready).toContain("✋ ask");
    // The scripted harness says so, where another names what powers it.
    expect(ready).toContain(SCRIPTED);
    expect(ready).not.toContain("powered by");
    await coder.prompt("hello there");
    const shown = await coder.waitFor("Ask me to run the tests");
    expect(shown).toContain("› hello there");
    // Markdown is rendered: markers concealed, code fenced.
    expect(shown).toContain("Here is what I found in this project");
    expect(shown).toContain("export function greet");
    expect(shown).toContain("▸ thinking");
    await coder.waitFor("ctx ");
  } finally {
    await coder.stop();
  }
}, 30000);

test("the website's demo: harness and project from the environment, one scripted session", async () => {
  // As the in-browser Server gets them (website/scripts/demo.ts): no command line.
  const coder = await startCoder({
    argv: [],
    env: { CODER_HARNESS: "fake", CODER_CWD: "/home/ada/src/timers" },
  });
  try {
    const ready = await coder.waitFor(SCRIPTED);
    expect(ready).toContain("/home/ada/src/timers");
    await coder.prompt(DEMO_PROMPT);
    const asked = await coder.waitFor("allow once");
    expect(asked).toContain("⚙ read src/duration.ts");
    expect(asked).toContain("✓ 0.2 s");
    expect(asked).toContain("Edit src/duration.ts");
    await coder.type("y");
    const done = await coder.waitFor(DEMO_END);
    expect(done).toContain("✎ src/duration.ts");
    expect(done).toContain("throw new RangeError");
    // Scripted durations: the capture and the page compare the same screen.
    expect(done).toContain("✓ exit 0 · 1.8 s");
    expect(done).not.toContain("The fake model is overloaded");
  } finally {
    await coder.stop();
  }
}, 30000);

test("a command streams its output; browsing folds and unfolds it", async () => {
  const coder = await startCoder();
  try {
    await coder.waitFor("scripted demo is ready");
    await coder.prompt("run the tests");
    await coder.waitFor("All 3 tests pass");
    const done = await coder.frame();
    expect(done).toContain("$ bun test");
    expect(done).toContain("✓ exit 0");
    // Folded once finished; Ctrl+O selects it, Enter unfolds it.
    expect(done).not.toContain("3 pass");
    await coder.press("o", { ctrl: true });
    await coder.press("return");
    await coder.waitFor("3 pass");
    await coder.press("return");
    await coder.waitFor((f) => !f.includes("3 pass"));
    await coder.press("i");
  } finally {
    await coder.stop();
  }
}, 30000);

test("an edit waits for approval in ask mode; y applies it and shows the diff", async () => {
  const coder = await startCoder();
  try {
    await coder.waitFor("scripted demo is ready");
    await coder.prompt("edit greet");
    const asked = await coder.waitFor("Edit src/greet.ts");
    expect(asked).toContain("allow once");
    expect(asked).toContain("deny");
    await coder.type("y");
    const applied = await coder.waitFor("Done: greet now uses a template literal");
    expect(applied).toContain("✎ src/greet.ts");
    expect(applied).toContain("+1");
    expect(applied).toContain("−1");
    expect(applied).not.toContain("allow once");
  } finally {
    await coder.stop();
  }
}, 30000);

test("a lost answer is looked up, never sent twice", async () => {
  let dropped = 0;
  const coder = await startCoder({
    network: {
      // The first answer reaches the Server, its response is lost: the outcome is unknown.
      fault: (request) =>
        request.kind === "action" && request.target.endsWith("#respond") && dropped++ === 0
          ? "drop"
          : undefined,
    },
  });
  try {
    await coder.waitFor("scripted demo is ready");
    await coder.prompt("edit greet");
    await coder.waitFor("Edit src/greet.ts");
    await coder.type("y");
    const shown = await coder.waitFor("Done: greet now uses a template literal");
    expect(dropped).toBeGreaterThan(0);
    // The request state says it was answered: no dialog again, no error.
    expect(shown).not.toContain("allow once");
    expect(shown).not.toContain("did not arrive");
    expect(shown.split("✎ src/greet.ts").length - 1).toBe(1);
  } finally {
    await coder.stop();
  }
}, 30000);

test("deny, questions and plan review answer the scripted harness", async () => {
  const coder = await startCoder();
  try {
    await coder.waitFor("scripted demo is ready");
    await coder.prompt("fix greet");
    await coder.waitFor("allow once");
    await coder.type("n");
    await coder.waitFor("I left src/greet.ts as it was");
    expect(await coder.frame()).toContain("(declined)");

    await coder.prompt("question");
    await coder.waitFor("Which test runner should I use?");
    await coder.type("2");
    await coder.waitFor("Going with vitest");

    await coder.prompt("plan it");
    await coder.waitFor("Nothing else is touched");
    await coder.type("y");
    await coder.waitFor("The plan is done");
    await coder.waitFor("Plan 3/3");
  } finally {
    await coder.stop();
  }
}, 30000);

test("Esc interrupts a running turn; Shift+Tab walks the modes; slash commands open pickers", async () => {
  const coder = await startCoder();
  try {
    await coder.waitFor("scripted demo is ready");
    await coder.prompt("slow please");
    await coder.waitFor("waiting 2");
    await coder.press("escape");
    await coder.waitFor("Interrupted");
    expect(await coder.frame()).toContain("exit 130");

    await coder.press("tab", { shift: true });
    await coder.waitFor("✎ auto edits");
    await coder.press("tab", { shift: true });
    await coder.waitFor("⚡ full access");

    await coder.type("/mo");
    await coder.waitFor("/model");
    await coder.prompt("del");
    await coder.waitFor("Fake Small");
    await coder.press("down");
    await coder.press("return");
    await coder.waitFor("fake-small ·");

    await coder.type("/status");
    await coder.press("return");
    await coder.waitFor("Account");
    expect(await coder.frame()).toContain("demo@example.com");
    await coder.press("escape");
  } finally {
    await coder.stop();
  }
}, 30000);

test("a cut feed comes back with Ctrl+R, a turn started meanwhile still running", async () => {
  let feeds = 0;
  const coder = await startCoder({
    network: {
      fault: (request) =>
        request.kind === "action" && request.target.endsWith("#feed") && feeds++ === 0
          ? "cut"
          : undefined,
    },
  });
  try {
    await coder.waitFor("Live feed closed");
    // Actions still work: the turn starts on the Server, unseen here.
    await coder.prompt("slow please");
    await coder.press("r", { ctrl: true });
    const back = await coder.waitFor("waiting 2");
    expect(back).toContain("$ sleep 30");
    expect(back).not.toContain("Live feed closed");
    await coder.press("escape");
    await coder.waitFor("Interrupted");
  } finally {
    await coder.stop();
  }
}, 30000);

test("a crashed Client's unsent prompt comes back; a sent one does not", async () => {
  const coder = await startCoder();
  let second: Awaited<ReturnType<typeof coder.client>> | undefined;
  try {
    await coder.waitFor("scripted demo is ready");
    await coder.prompt("hello");
    await coder.waitFor("Ask me to run the tests");
    await coder.type("half a thought");
    await coder.waitFor("half a thought");
    const left = coder.app.restoration.snapshot();
    await coder.crash();
    second = await coder.client({ session: left });
    const restored = await second.waitFor("half a thought");
    // The transcript comes from the Server, the draft from the session.
    expect(restored).toContain("› hello");
    expect(restored.split("hello").length - 1).toBe(1);
  } finally {
    await second?.close();
    await coder.stop();
  }
}, 30000);
