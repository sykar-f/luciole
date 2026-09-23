/** @jsxImportSource @opentui/react */
import { beforeAll, expect, test } from "bun:test";
import { InputRenderable } from "@opentui/core";
import { build } from "../src/build";
import { forgeDirectory, startForge } from "./forge-helpers";
import { until, draftsOf } from "./helpers";

beforeAll(async () => {
  await build(forgeDirectory);
}, 60000);

const ctrl = { ctrl: true };

test("anonymous start redirects to the public login; a bad PIN stays there", async () => {
  const forge = await startForge();
  try {
    expect(forge.path()).toBe("/login");
    expect(await forge.frame()).toContain("Demo accounts");
    await forge.step(() => forge.ui.mockInput.typeText("alice"));
    await forge.step(() => forge.ui.mockInput.pressEnter());
    await forge.step(() => forge.ui.mockInput.typeText("1234"));
    await forge.step(() => forge.ui.mockInput.pressEnter());
    await forge.waitFor("Unknown user or wrong PIN");
    expect(forge.path()).toBe("/login");
    // Tab switches fields without being typed into them.
    await forge.step(() => forge.ui.mockInput.pressTab());
    await forge.step(() => forge.ui.mockInput.pressTab());
    const typed = (id: string) => {
      const field = forge.ui.renderer.root.findDescendantById(id);
      return field instanceof InputRenderable ? field.value : undefined;
    };
    expect(typed("login-user")).toBe("alice");
    expect(typed("login-pin")).toBe("1234");
    // Public action, protected everything else: a protected read is refused.
    const raw = await fetch(`${forge.server.url}/render?route=%2F(app)&params=%7B%7D`, {
      headers: { "x-airtty-build": forge.server.buildId },
    });
    expect(raw.status).toBe(401);
  } finally {
    await forge.stop();
  }
}, 30000);

test("reviewer journey: line comment, approval, then Drafts never cross accounts", async () => {
  const forge = await startForge();
  const { ui, step, waitFor, operator } = forge;
  try {
    await forge.signIn("bob");
    const application = forge.app;
    const shown = await forge.frame();
    expect(shown).toContain("Review requested".toUpperCase());
    expect(shown).toContain("Stream settlement reports");

    // Files tab: the file list arrives first, diffs stream behind Suspense.
    await step(() =>
      application.router.navigate({
        to: "/repos/$repo/pulls/$number/files",
        params: { repo: "payments", number: "2" },
      }),
    );
    await waitFor("src/report.ts · typescript");
    await step(() => ui.mockInput.typeText("]"));
    await waitFor("src/settlement.ts · typescript");
    for (let i = 0; i < 8; i++) await step(() => ui.mockInput.typeText("j"));
    await waitFor("line 9");
    await step(() => ui.mockInput.typeText("c"));
    await waitFor("Comment on src/settlement.ts:9");
    await step(() => ui.mockInput.typeText("Name this page size"));
    const before = operator.count("comments");
    await step(() => ui.mockInput.pressKey("s", ctrl));
    await step(() => until(() => operator.count("comments") === before + 1));
    await waitFor("@bob: Name this page size");
    const comment = operator.comments(operator.pull("payments", 2)!.id).at(-1);
    expect(comment).toMatchObject({
      author: "bob",
      path: "src/settlement.ts",
      side: "new",
      line: 9,
    });

    // Tab moves to Checks then Conversation; the viewed marks live in the layout.
    await step(() => ui.mockInput.typeText("v"));
    await waitFor("files 1/2 viewed");
    await step(() => ui.mockInput.pressTab());
    await waitFor("log complete");
    await step(() => ui.mockInput.pressTab());
    await waitFor("[a] approve");
    await step(() => ui.mockInput.typeText("a"));
    await waitFor("Approvals: @bob");
    await step(() => ui.mockInput.pressTab({ shift: true }));
    await step(() => ui.mockInput.pressTab({ shift: true }));
    await waitFor("files 1/2 viewed");

    // An unsaved comment on another pull request, then sign out.
    await step(() =>
      application.router.navigate({
        to: "/repos/$repo/pulls/$number",
        params: { repo: "payments", number: "1" },
      }),
    );
    await waitFor("[c] comment");
    await step(() => ui.mockInput.typeText("c"));
    await step(() => ui.mockInput.typeText("bob's private thought"));
    await step(() => ui.mockInput.pressEscape());
    await waitFor("Drafts 1/32 unsaved");
    await step(() => ui.mockInput.pressKey("l", ctrl));
    await waitFor("Ctrl+L again to sign out");
    await step(() => ui.mockInput.pressKey("l", ctrl));
    await step(() => until(() => forge.path() === "/login"));
    expect(draftsOf(application).size).toBe(0);

    await forge.signIn("alice");
    await step(() =>
      application.router.navigate({
        to: "/repos/$repo/pulls/$number",
        params: { repo: "payments", number: "1" },
      }),
    );
    const aliceView = await waitFor("[m] merge");
    expect(aliceView).not.toContain("private thought");
    expect(aliceView).toContain("Drafts 0/32 unsaved");
  } finally {
    await forge.stop();
  }
}, 60000);

test("a merge whose response is lost is resolved from the ledger, never replayed", async () => {
  const forge = await startForge();
  const { ui, step, waitFor, operator } = forge;
  try {
    await forge.signIn("alice");
    await step(() =>
      forge.app.router.navigate({
        to: "/repos/$repo/pulls/$number",
        params: { repo: "payments", number: "1" },
      }),
    );
    await waitFor("[m] merge");
    await step(() => ui.mockInput.typeText("a"));
    await waitFor("Ready to merge");
    operator.operator.armFault("merge");
    await step(() => ui.mockInput.typeText("m"));
    await waitFor("outcome unknown");
    expect(operator.pull("payments", 1)!.state).toBe("merged");
    // A second attempt is blocked locally while the outcome is unknown.
    await step(() => ui.mockInput.typeText("m"));
    await forge.settle(200);
    expect(
      operator.activity(50).filter((a) => a.action === "merge" && a.target === "payments#1"),
    ).toHaveLength(1);
    await step(() => ui.mockInput.pressKey("o", ctrl));
    await waitFor("Merged #1 into main");
    await waitFor("Merged by @alice");
    // The chrome reads its counts through a Server Function: refreshed with the routes.
    await waitFor("payments (2)");
    expect(
      operator.activity(50).filter((a) => a.action === "merge" && a.target === "payments#1"),
    ).toHaveLength(1);
  } finally {
    await forge.stop();
  }
}, 60000);

test("a description Draft survives a concurrent edit until it is explicitly discarded", async () => {
  const forge = await startForge();
  const { ui, step, waitFor, operator } = forge;
  try {
    await forge.signIn("alice");
    await step(() =>
      forge.app.router.navigate({
        to: "/repos/$repo/pulls/$number",
        params: { repo: "payments", number: "2" },
      }),
    );
    await waitFor("[e] edit description");
    await step(() => ui.mockInput.typeText("e"));
    await step(() => ui.mockInput.typeText(" (draft by alice)"));
    await waitFor("Unsaved Draft");
    operator.operator.editDescription("payments", 2, "Rewritten by the release manager.");
    await step(() => ui.mockInput.pressKey("r", ctrl));
    await waitFor("Server changed · Draft kept");
    expect(await forge.frame()).toContain("(draft by alice)");
    await step(() => ui.mockInput.pressKey("s", ctrl));
    await waitFor("Description changed on the Server");
    await step(() => ui.mockInput.pressKey("x", ctrl));
    await step(() => ui.mockInput.pressEscape());
    await waitFor("Rewritten by the release manager.");
    expect(await forge.frame()).not.toContain("(draft by alice)");
  } finally {
    await forge.stop();
  }
}, 60000);

test("CI logs stream live through Flight, then the rerun unblocks the merge", async () => {
  const forge = await startForge({ env: { FORGE_CI_SCALE: "0.6" } });
  const { ui, step, waitFor, operator } = forge;
  try {
    await forge.signIn("bob");
    operator.review(
      operator.authenticate((operator.login("bob", "forge") as { token: string }).token)!,
      {
        repo: "payments",
        number: 2,
        revision: 1,
        verdict: "approve",
        operationId: crypto.randomUUID(),
      },
    );
    await step(() =>
      forge.app.router.navigate({
        to: "/repos/$repo/pulls/$number/checks",
        params: { repo: "payments", number: "2" },
      }),
    );
    await waitFor("✗ test");
    await step(() => ui.mockInput.typeText("r"));
    await waitFor("Checks restarted (attempt 2)");
    await step(() => ui.mockInput.typeText("j"));
    // Lines arrive one by one while the page stays interactive.
    const partial = await waitFor("$ bun test", 8000);
    expect(partial).toContain("streaming…");
    expect(partial).toContain("◐ test");
    expect(partial).not.toContain("passed (attempt 2)");
    const before = await forge.metrics();
    await step(() => ui.mockInput.typeText("k"));
    await step(() => ui.mockInput.typeText("j"));
    expect((await forge.metrics()).renders).toBe(before.renders);
    await waitFor("✓ passed (attempt 2)", 15000);
    // The component that watched a running check invalidates once it ends.
    await waitFor("✓ test", 5000);
    await step(() => ui.mockInput.pressTab());
    await waitFor("Ready to merge");
  } finally {
    await forge.stop();
  }
}, 60000);

test("opening a pull request: the static /pulls/new route beats /pulls/$number", async () => {
  const forge = await startForge();
  const { ui, step, waitFor, operator } = forge;
  try {
    await forge.signIn("bob");
    await step(() =>
      forge.app.router.navigate({ to: "/repos/$repo", params: { repo: "payments" } }),
    );
    await waitFor("open pull request(s)");
    // The state filter is in the URL and applied by the Server; back restores it.
    await step(() => ui.mockInput.typeText("s"));
    await waitFor("Initial ledger schema");
    expect(forge.app.router.state.location.href).toBe("/repos/payments?state=merged");
    expect(await forge.frame()).not.toContain("Add idempotency keys");
    await step(() => ui.mockInput.typeText("u"));
    await waitFor("Add idempotency keys");
    expect(forge.app.router.state.location.href).toBe("/repos/payments");
    await step(() => ui.mockInput.typeText("n"));
    await waitFor("Open a pull request in payments");
    expect(forge.path()).toBe("/repos/payments/pulls/new");
    expect(forge.app.router.state.matches.at(-1)?.routeId).toContain("pulls/new");
    await step(() => ui.mockInput.pressTab());
    await step(() => ui.mockInput.typeText("Retry webhooks"));
    await step(() => ui.mockInput.pressTab());
    await step(() => ui.mockInput.typeText("Retries 5xx with exponential backoff."));
    await step(() => ui.mockInput.pressKey("s", ctrl));
    await step(() => until(() => forge.path() === "/repos/payments/pulls/5"));
    await waitFor("#5 Retry webhooks");
    expect(operator.pull("payments", 5)).toMatchObject({ author: "bob", title: "Retry webhooks" });
    expect(draftsOf(forge.app).unsaved()).toEqual([]);
  } finally {
    await forge.stop();
  }
}, 60000);

test("a missing pull request shows the not-found screen inside the chrome", async () => {
  const forge = await startForge();
  try {
    await forge.signIn("carol");
    await forge.step(() =>
      forge.app.router.navigate({
        to: "/repos/$repo/pulls/$number",
        params: { repo: "payments", number: "99" },
      }),
    );
    await forge.waitFor("Pull request payments#99 not found");
    // A reader sees no write command.
    await forge.step(() =>
      forge.app.router.navigate({
        to: "/repos/$repo/pulls/$number",
        params: { repo: "payments", number: "1" },
      }),
    );
    const shown = await forge.waitFor("Not ready");
    expect(shown).not.toContain("[a] approve");
    expect(shown).not.toContain("[c] comment");
  } finally {
    await forge.stop();
  }
}, 30000);
