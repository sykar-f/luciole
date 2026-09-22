import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "../src/build";
import { createForge } from "../examples/forge/server/forge";
import { importGitRepository } from "../examples/forge/server/git-import";
import { openDatabase } from "../examples/forge/server/schema";
import { launch } from "./helpers";

const directory = resolve("examples/forge");

test("Forge artefacts: SQL, git, sessions and seed data never reach the Client", async () => {
  await build(directory);
  const manifest = await Bun.file(join(directory, ".airtty/manifest.json")).json();
  const client = await Bun.file(join(directory, ".airtty/client/index.js")).text();
  const server = await Bun.file(join(directory, ".airtty/server/index.js")).text();
  const serverOnly = [
    "CREATE TABLE IF NOT EXISTS",
    "token_hash",
    "bun:sqlite",
    "diff-tree",
    "CryptoHasher",
    "Refund exceeds captured amount", // seeded source file contents
    "Injected lost",
  ];
  for (const marker of serverOnly) {
    expect(client).not.toContain(marker);
    expect(server).toContain(marker);
  }
  expect(manifest.clientGraph.filter((p: string) => p.startsWith("server/"))).toEqual([]);
  expect(
    manifest.clientGraph.filter((p: string) => p.startsWith("app/") && p.endsWith("page.tsx")),
  ).toEqual([]);
  expect(
    manifest.routes.map((r: { url: string; auth: string }) => `${r.auth} ${r.url}`).sort(),
  ).toEqual([
    "public /login",
    "required /",
    "required /repos/$repo",
    "required /repos/$repo/pulls/$number",
    "required /repos/$repo/pulls/$number/checks",
    "required /repos/$repo/pulls/$number/files",
    "required /repos/$repo/pulls/new",
  ]);
}, 60000);

test("a rendered page carries the public identity, never the session", async () => {
  const temp = await mkdtemp(join(tmpdir(), "forge-flight-"));
  const database = join(temp, "forge.sqlite");
  const server = await launch(join(directory, ".airtty/server/index.js"), {
    FORGE_DB: database,
    FORGE_SLOW_MS: "0",
  });
  const db = openDatabase(database);
  try {
    const login = createForge(db).login("alice", "forge");
    if (!login.ok) throw new Error(login.error);
    const sessionId = new Bun.CryptoHasher("sha256").update(login.token).digest("hex");
    const query = new URLSearchParams({
      route: "/(app)/repos/[repo]/pulls/[number]",
      params: JSON.stringify({ repo: "payments", number: "1" }),
    });
    const response = await fetch(`${server.url}/render?${query}`, {
      headers: { "x-airtty-build": server.buildId, authorization: `Bearer ${login.token}` },
    });
    const body = await response.text();
    expect(response.status).toBe(200);
    expect(body).toContain("Alice Martin");
    expect(body).toContain("Add idempotency keys to refunds");
    expect(body).not.toContain(sessionId);
    expect(body).not.toContain(login.token);
    expect(body).not.toContain("sessionId");
  } finally {
    db.close();
    await server.stop();
    await rm(temp, { recursive: true, force: true });
  }
}, 30000);

test("git import turns real commits of this checkout into reviewable pull requests", async () => {
  const temp = await mkdtemp(join(tmpdir(), "forge-git-"));
  const db = openDatabase(join(temp, "forge.sqlite"));
  try {
    const forge = createForge(db);
    expect(importGitRepository(forge, resolve("."), "airtty", 4)).toBe(4);
    expect(importGitRepository(forge, resolve("."), "airtty", 4)).toBe(0);
    const pulls = forge.pulls("airtty");
    expect(pulls.length).toBeGreaterThan(0);
    const pull = forge.pull("airtty", pulls[0].number)!;
    const files = forge.files(pull.id, pull.revision);
    expect(files.length).toBeGreaterThan(0);
    const diff = forge.fileDiff(pull.id, pull.revision, files[0].path)!;
    expect(diff.patch.startsWith("--- ")).toBe(true);
    expect(diff.rows.length).toBe(
      diff.additions + diff.deletions + diff.rows.filter((r) => r.kind === "context").length,
    );
  } finally {
    db.close();
    await rm(temp, { recursive: true, force: true });
  }
}, 30000);
