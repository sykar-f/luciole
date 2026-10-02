/**
 * studio's project, guard and policy (examples/studio/server): the pieces that decide
 * what reaches the build and what the harness may do, without a Server.
 */
import { test, expect } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative as relativePath, resolve } from "node:path";
import { advise, guard } from "../examples/studio/server/guard";
import { policy } from "../examples/studio/server/policy";
import { diagnosticsOf } from "../examples/studio/server/preview";
import { execute, rejectionOf } from "./helpers";
import { Project } from "../examples/studio/server/project";
import { TEMPLATE } from "../examples/studio/server/template.gen";
import { messageOf } from "../packages/core/src/guards";

function scratch() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "studio-project-")));
  return { root, [Symbol.dispose]: () => rmSync(root, { recursive: true, force: true }) };
}

test("the generated template matches examples/studio/template", async () => {
  const check = await execute([
    process.execPath,
    resolve("examples/studio/scripts/template.ts"),
    "--check",
  ]);
  expect(check.stderr.toString()).toBe("");
  expect(check.exitCode).toBe(0);
});

test("a new project is the template as r0, linked to the framework's packages", async () => {
  using dir = scratch();
  const project = await Project.open(join(dir.root, "demo"));
  try {
    for (const [file, content] of Object.entries(TEMPLATE))
      expect(readFileSync(join(project.directory, file), "utf8")).toBe(content);
    expect(existsSync(join(project.directory, "node_modules/react/package.json"))).toBe(true);
    expect(project.revisions().map((r) => [r.number, r.summary])).toEqual([[0, "template"]]);
    expect((await project.changes()).size).toBe(0);
    // Studio's own files and the app's data never show as changes.
    project.data();
    writeFileSync(join(project.data(), "app.sqlite"), "x");
    expect((await project.changes()).size).toBe(0);
  } finally {
    project.release();
  }
});

test("changes, discard, commit, restore and patch follow the working tree", async () => {
  using dir = scratch();
  const project = await Project.open(join(dir.root, "demo"));
  try {
    const greeting = join(project.directory, "server/greeting.ts");
    writeFileSync(greeting, 'export const greeting = "changed";\n');
    mkdirSync(join(project.directory, "components"), { recursive: true });
    writeFileSync(join(project.directory, "components/Extra.tsx"), "export const x = 1;\n");
    expect([...(await project.changes()).keys()].sort()).toEqual([
      "components/Extra.tsx",
      "server/greeting.ts",
    ]);
    // Refused changes go back as the last revision has them.
    await project.discard(["components/Extra.tsx", "server/greeting.ts"]);
    expect((await project.changes()).size).toBe(0);
    expect(readFileSync(greeting, "utf8")).toBe(TEMPLATE["server/greeting.ts"] ?? "");
    writeFileSync(greeting, 'export const greeting = "r1";\n');
    expect(await project.commit("Change the greeting\nwith details")).toBe(1);
    writeFileSync(greeting, 'export const greeting = "r2";\n');
    writeFileSync(join(project.directory, "components/Extra.tsx"), "export const x = 2;\n");
    expect(await project.commit("Another change")).toBe(2);
    expect(project.revisions().map((r) => `r${r.number} ${r.summary}`)).toEqual([
      "r2 Another change",
      "r1 Change the greeting",
      "r0 template",
    ]);
    const patch = await project.patch(1);
    expect(patch.map((p) => p.path)).toEqual(["server/greeting.ts"]);
    expect(patch[0]?.patch).toContain('+export const greeting = "r1";');
    // Restoring r1: its files, and none it did not have, as revision r3.
    expect(await project.restore(1)).toBe(3);
    expect(readFileSync(greeting, "utf8")).toBe('export const greeting = "r1";\n');
    expect(existsSync(join(project.directory, "components/Extra.tsx"))).toBe(false);
    expect(project.revisions()[0]?.summary).toBe("restored r1");
  } finally {
    project.release();
  }
});

test("studio never writes into a directory it did not create, nor opens a project twice", async () => {
  using dir = scratch();
  const other = join(dir.root, "someone-else");
  mkdirSync(other);
  writeFileSync(join(other, "notes.txt"), "mine");
  expect(messageOf(await rejectionOf(Project.open(other)))).toMatch(/is not a studio project/);
  expect(readFileSync(join(other, "notes.txt"), "utf8")).toBe("mine");
  const project = await Project.open(join(dir.root, "demo"));
  try {
    // Another live studio holds it (here: this test's parent process).
    writeFileSync(join(project.state, "studio.pid"), String(process.ppid));
    let refusal = "";
    try {
      await Project.open(project.directory);
    } catch (error: unknown) {
      refusal = messageOf(error);
    }
    expect(refusal).toContain("is open in another studio");
  } finally {
    rmSync(join(project.state, "studio.pid"), { force: true });
  }
});

test("the guard keeps the harness in the app's folders and packages", () => {
  const refused = guard(
    new Map<string, string | null>([
      [
        "components/Ok.tsx",
        `"use client";\nimport { useState } from "react";\nimport { useBindings } from "@luciole-sh/core/client";\nexport const x = [useState, useBindings];\n`,
      ],
      [
        "server/db.ts",
        `import { Database } from "bun:sqlite";\nimport { join } from "node:path";\nexport const x = [Database, join];\n`,
      ],
      ["components/Old.tsx", null],
      ["package.json", "{}"],
      ["../outside.ts", "export {}"],
      ["components/Chart.tsx", `import numeral from "numeral";\nexport const x = numeral;\n`],
      [
        "server/git.ts",
        `import { execSync } from "node:child_process";\nexport const x = execSync;\n`,
      ],
      ["server/net.ts", `export const x = () => Bun.spawn(["ls"]);\n`],
    ]),
  );
  expect(refused.map((r) => r.file)).toEqual([
    "package.json",
    "../outside.ts",
    "components/Chart.tsx",
    "server/git.ts",
    "server/net.ts",
  ]);
  expect(refused.find((r) => r.file === "components/Chart.tsx")?.reason).toBe(
    "imports numeral, not in the allowed packages",
  );
});

test("a field without a name is advised, not refused: named, spread or elsewhere, it is not", () => {
  const form = `"use client";
import { Input, Textarea } from "@luciole-sh/core/client";
export function Form(props: { name: string }) {
  return (
    <box>
      <Input value="" onInput={(v) => (v.length > 2 ? v : v)} placeholder="a > b" />
      <Input name="form/title" value="" onInput={() => {}} />
      <Input
        focused
        name="form/body"
        value={props.name}
      />
      <Textarea value="" onChange={() => {}} placeholder={\`name=\${props.name}\`} />
      <Input {...props} value="" />
      <input value="" />
    </box>
  );
}
`;
  const changes = new Map<string, string | null>([
    ["components/Form.tsx", form],
    ["components/Gone.tsx", null],
    ["server/text.ts", `export const tag = "<Input value />";\n`],
  ]);
  expect(guard(changes)).toEqual([]);
  const advice = advise(changes);
  expect(advice.map((a) => [a.file, a.line])).toEqual([
    ["components/Form.tsx", 6],
    ["components/Form.tsx", 13],
    ["components/Form.tsx", 15],
  ]);
  expect(advice[0]?.message).toContain('name it (name="form/field")');
  expect(advice[2]?.message).toContain("use Input from @luciole-sh/core/client");
});

test("the template names its fields: nothing to advise", () => {
  expect(advise(new Map(Object.entries(TEMPLATE)))).toEqual([]);
});

test("the policy refuses commands and writes outside the app, and leaves questions to the user", () => {
  const approval = {
    id: "a",
    openedAt: 0,
    kind: "approval" as const,
    title: "t",
    decisions: ["once", "deny"] as const,
  };
  const file = (path: string) => ({ path, patch: "", additions: 1, deletions: 0 });
  expect(policy({ ...approval, command: "bun test" })).toEqual({
    kind: "approval",
    decision: "deny",
  });
  expect(policy({ ...approval, files: [file("app/page.tsx"), file("components/A.tsx")] })).toEqual({
    kind: "approval",
    decision: "once",
  });
  expect(policy({ ...approval, files: [file("app/page.tsx"), file("package.json")] })).toEqual({
    kind: "approval",
    decision: "deny",
  });
  expect(policy({ ...approval, files: [file("/etc/hosts")] })).toEqual({
    kind: "approval",
    decision: "deny",
  });
  expect(policy({ id: "q", openedAt: 0, kind: "question", questions: [] })).toBeUndefined();
});

test("the template passes studio's own guard: a harness editing it is never refused for it", () => {
  const changes = new Map(Object.entries(TEMPLATE).filter(([file]) => /\.(ts|tsx)$/.test(file)));
  expect(guard(changes)).toEqual([]);
});

test("build diagnostics name the app's file, whatever directory studio runs from", () => {
  const project = "/tmp/studio-diagnostics/app";
  const relative = relativePath(process.cwd(), `${project}/server/store.ts`);
  expect(
    diagnosticsOf(`No matching export in "${relative}" for import "missing"`, project),
  ).toEqual([
    {
      file: "server/store.ts",
      message: 'No matching export in "server/store.ts" for import "missing"',
    },
  ]);
  expect(
    diagnosticsOf(`${project}/app/page.tsx:3:5: JSX element 'text' has no closing tag.`, project),
  ).toEqual([{ file: "app/page.tsx", line: 3, message: "JSX element 'text' has no closing tag." }]);
});

test("studio drives Claude Code or its generator; another harness is refused with the reason", async () => {
  const { default: cli } = await import("../examples/studio/app/args");
  expect(await cli.parse(["--harness", "claude"], { cwd: "/" })).toMatchObject({
    harness: "claude",
  });
  expect(await cli.parse(["-H", "fake"], { cwd: "/" })).toMatchObject({ harness: "fake" });
  for (const other of ["codex", "pi", "opencode"]) {
    let refusal = "";
    try {
      await cli.parse(["--harness", other], { cwd: "/" });
    } catch (error: unknown) {
      refusal = messageOf(error);
    }
    expect(refusal).toContain("Codex, pi and opencode run in coder for now");
  }
});
