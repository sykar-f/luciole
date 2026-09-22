import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  conversationSlot,
  createForge,
  descriptionId,
  lineSlot,
  newPullSlot,
  type Actor,
} from "../examples/forge/server/forge";
import { openDatabase } from "../examples/forge/server/schema";
import { diffRows, unifiedDiff } from "../examples/forge/server/diff";

async function withForge(
  run: (forge: ReturnType<typeof createForge>, clock: { t: number }) => Promise<void> | void,
) {
  const dir = await mkdtemp(join(tmpdir(), "forge-domain-"));
  const clock = { t: Date.UTC(2026, 8, 22, 12) };
  const db = openDatabase(join(dir, "forge.sqlite"));
  try {
    await run(createForge(db, { now: () => clock.t, ciScale: 1 }), clock);
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
}
const actor = (forge: ReturnType<typeof createForge>, id: string): Actor => {
  const login = forge.login(id, "forge");
  if (!login.ok) throw new Error(login.error);
  const found = forge.authenticate(login.token);
  if (!found) throw new Error("no session");
  return found;
};
const op = () => crypto.randomUUID();
const snapshot = (id: string, value: string, version: number) => ({
  id,
  value,
  version,
  revision: 1,
  operationId: op(),
});

test("unified diff rows follow the drawing order of the renderable", () => {
  const patch = unifiedDiff("a.ts", "a\nb\nc\n", "a\nB\nc\nd\n");
  expect(patch).toBe("--- a/a.ts\n+++ b/a.ts\n@@ -1,3 +1,4 @@\n a\n-b\n+B\n c\n+d\n");
  expect(diffRows(patch)).toEqual([
    { kind: "context", old: 1, new: 1 },
    { kind: "delete", old: 2 },
    { kind: "add", new: 2 },
    { kind: "context", old: 3, new: 3 },
    { kind: "add", new: 4 },
  ]);
  expect(unifiedDiff("n.ts", "", "x\n")).toBe("--- a/n.ts\n+++ b/n.ts\n@@ -0,0 +1,1 @@\n+x\n");
});

test("two fresh databases hold the same deterministic demo state", async () => {
  const dump = async () => {
    let out = "";
    await withForge((forge) => {
      out = JSON.stringify(
        forge.repos().map((r) => ({
          r,
          pulls: forge.pulls(r.slug).map((p) => {
            const detail = forge.pull(r.slug, p.number)!;
            return {
              p,
              files: forge.files(detail.id, detail.revision),
              comments: forge.comments(detail.id),
              reviews: forge.reviews(detail.id),
            };
          }),
        })),
      );
    });
    return out;
  };
  const first = await dump();
  expect(first).toBe(await dump());
  expect(first).toContain("Add idempotency keys to refunds");
});

test("sessions: PIN login, bearer resolution, logout revocation", () =>
  withForge((forge, clock) => {
    expect(forge.login("alice", "nope")).toEqual({ ok: false, error: "Unknown user or wrong PIN" });
    expect(forge.login("mallory", "forge").ok).toBe(false);
    const login = forge.login(" Alice ", "forge");
    if (!login.ok) throw new Error("login");
    expect(login.identity).toEqual({ id: "alice", name: "Alice Martin", role: "maintainer" });
    const alice = forge.authenticate(login.token)!;
    expect(alice.id).toBe("alice");
    expect(forge.authenticate("forged")).toBeNull();
    forge.logout(alice);
    expect(forge.authenticate(login.token)).toBeNull();
    const again = forge.login("bob", "forge");
    if (!again.ok) throw new Error("login");
    clock.t += 13 * 60 * 60_000;
    expect(forge.authenticate(again.token)).toBeNull();
  }));

test("rights are enforced by the domain, not by the screens", () =>
  withForge((forge) => {
    const [alice, bob, carol] = ["alice", "bob", "carol"].map((id) => actor(forge, id));
    const pr1 = forge.pull("payments", 1)!;
    const review = (who: Actor, verdict: "approve" | "changes", pr = pr1) =>
      forge.review(who, {
        repo: "payments",
        number: pr.number,
        revision: pr.revision,
        verdict,
        operationId: op(),
      });
    expect(review(bob, "approve")).toMatchObject({
      ok: false,
      error: "Authors cannot review their own pull request",
    });
    expect(review(carol, "approve")).toMatchObject({ ok: false, error: "Readers cannot review" });
    expect(forge.publish(carol, snapshot(conversationSlot(pr1.id), "hi", 0))).toMatchObject({
      ok: false,
      error: "Readers cannot publish",
    });
    expect(forge.saveDescription(carol, snapshot(descriptionId(pr1.id), "x", 1))).toMatchObject({
      ok: false,
    });
    expect(
      forge.merge(bob, { repo: "payments", number: 1, revision: 1, operationId: op() }),
    ).toMatchObject({
      ok: false,
      error: "Only maintainers can merge",
    });
    expect(
      forge.merge(alice, { repo: "payments", number: 1, revision: 1, operationId: op() }),
    ).toMatchObject({
      ok: false,
      error: "No approval on revision 1",
    });
    expect(() =>
      forge.review(alice, {
        repo: "payments",
        number: 1,
        revision: 1,
        verdict: "lgtm",
        operationId: op(),
      }),
    ).toThrow("Invalid verdict");
    expect(() =>
      forge.merge(alice, { repo: "payments", number: 1, revision: 1, operationId: "1" }),
    ).toThrow("Invalid operation");
  }));

test("a merge commits once: the same operation returns the stored result", () =>
  withForge((forge) => {
    const [alice, bob] = ["alice", "bob"].map((id) => actor(forge, id));
    const pr2 = forge.pull("payments", 2)!;
    expect(forge.readiness(pr2.id)).toMatchObject({
      approvals: [],
      canMerge: false,
      reasons: ["No approval on revision 1", "A check failed"],
    });
    const bobReview = forge.review(bob, {
      repo: "payments",
      number: 1,
      revision: 1,
      verdict: "approve",
      operationId: op(),
    });
    expect(bobReview.ok).toBe(false);
    const approve = forge.review(alice, {
      repo: "payments",
      number: 1,
      revision: 1,
      verdict: "approve",
      operationId: op(),
    });
    expect(approve).toMatchObject({ ok: true, message: "Approved" });
    const id = op();
    const merged = forge.merge(alice, {
      repo: "payments",
      number: 1,
      revision: 1,
      operationId: id,
    });
    expect(merged).toEqual({ ok: true, operationId: id, message: "Merged #1 into main" });
    expect(
      forge.merge(alice, { repo: "payments", number: 1, revision: 1, operationId: id }),
    ).toEqual(merged);
    expect(forge.operation(alice, id)).toEqual(merged);
    expect(forge.operation(bob, id)).toBeNull();
    expect(forge.pull("payments", 1)!.state).toBe("merged");
    expect(
      forge.merge(alice, { repo: "payments", number: 1, revision: 1, operationId: op() }),
    ).toMatchObject({ ok: false });
    expect(
      forge.activity(50).filter((a) => a.action === "merge" && a.target === "payments#1"),
    ).toHaveLength(1);
  }));

test("a flaky check fails, reruns, then lets the merge through as time passes", () =>
  withForge((forge, clock) => {
    const alice = actor(forge, "alice");
    const pr2 = forge.pull("payments", 2)!;
    const failing = forge.checks(pr2.id, 1);
    expect(failing.map((c) => [c.name, c.status])).toEqual([
      ["lint", "success"],
      ["test", "failure"],
      ["build", "success"],
    ]);
    expect(forge.rerun(alice, { repo: "payments", number: 2, operationId: op() })).toMatchObject({
      ok: true,
      message: "Checks restarted (attempt 2)",
    });
    expect(forge.checks(pr2.id, 1).map((c) => c.status)).toEqual(["queued", "queued", "queued"]);
    expect(forge.rerun(alice, { repo: "payments", number: 2, operationId: op() })).toMatchObject({
      ok: false,
    });
    clock.t += 1000;
    expect(forge.checks(pr2.id, 1).map((c) => c.status)).toEqual(["running", "running", "running"]);
    clock.t += 10_000;
    expect(forge.checks(pr2.id, 1).map((c) => c.status)).toEqual(["success", "success", "success"]);
    expect(forge.readiness(pr2.id).reasons).toEqual(["No approval on revision 1"]);
    const bob = actor(forge, "bob");
    expect(
      forge.review(bob, {
        repo: "payments",
        number: 2,
        revision: 1,
        verdict: "approve",
        operationId: op(),
      }).ok,
    ).toBe(true);
    expect(forge.readiness(pr2.id).canMerge).toBe(true);
    expect(
      forge.merge(alice, { repo: "payments", number: 2, revision: 1, operationId: op() }).ok,
    ).toBe(true);
  }));

test("CI logs stream as the clock reaches each line", async () => {
  await withForge(async (forge) => {
    const pr1 = forge.pull("payments", 1)!;
    const lint = forge.checks(pr1.id, 1)[0];
    const lines: string[] = [];
    for await (const line of forge.checkLog(lint.id)) lines.push(line);
    expect(lines[0]).toBe("[00:00.0] $ bun run lint");
    expect(lines.at(-1)).toContain("✓ passed (attempt 1)");
  });
});

test("documents: description versions, composers and new pull requests", () =>
  withForge((forge) => {
    const [alice, bob] = ["alice", "bob"].map((id) => actor(forge, id));
    const pr1 = forge.pull("payments", 1)!;
    const note = forge.descriptionNote(pr1.id);
    const saved = forge.saveDescription(bob, snapshot(note.id, "  Updated  ", note.version));
    expect(saved).toMatchObject({ ok: true, note: { id: note.id, value: "Updated", version: 2 } });
    expect(forge.saveDescription(alice, snapshot(note.id, "stale", 1))).toMatchObject({
      ok: false,
      error: "Description changed on the Server: discard to reload",
    });
    const slot = conversationSlot(pr1.id);
    const published = forge.publish(alice, snapshot(slot, "Looks good", 0));
    expect(published).toMatchObject({ ok: true, note: { id: slot, value: "", version: 1 } });
    expect(forge.publish(alice, snapshot(slot, "twice", 0))).toMatchObject({ ok: false });
    expect(forge.composerNote(alice, slot).version).toBe(1);
    expect(forge.comments(pr1.id).at(-1)).toMatchObject({
      author: "alice",
      body: "Looks good",
      path: null,
    });

    const line = lineSlot(pr1.id, 1, "new", 13, "src/refunds.ts");
    expect(forge.publish(alice, snapshot(line, "Why a regex here?", 0))).toMatchObject({
      ok: true,
    });
    expect(forge.comments(pr1.id).at(-1)).toMatchObject({
      path: "src/refunds.ts",
      side: "new",
      line: 13,
    });
    expect(forge.composerVersions(alice, pr1.id)).toEqual({ [line]: 1 });
    expect(
      forge.publish(alice, snapshot(lineSlot(pr1.id, 1, "new", 999, "src/refunds.ts"), "x", 0)),
    ).toMatchObject({
      ok: false,
      error: "This line is not part of the diff",
    });
    expect(forge.operator.push("payments", 1)).toBe(2);
    expect(
      forge.publish(alice, snapshot(lineSlot(pr1.id, 1, "new", 14, "src/refunds.ts"), "late", 0)),
    ).toMatchObject({
      ok: false,
    });

    const created = forge.publish(
      bob,
      snapshot(newPullSlot("payments"), "Retries 5xx with backoff", 0),
      { title: "Retry webhooks", branch: "feature/webhook-retries" },
    );
    expect(created).toMatchObject({ ok: true, number: 5, note: { value: "", version: 1 } });
    expect(forge.pull("payments", 5)).toMatchObject({
      title: "Retry webhooks",
      author: "bob",
      additions: 8,
    });
    expect(
      forge.publish(bob, snapshot(newPullSlot("payments"), "again", 1), {
        title: "Retry webhooks",
        branch: "feature/webhook-retries",
      }),
    ).toMatchObject({ ok: false, error: "This branch already has a pull request" });
  }));
