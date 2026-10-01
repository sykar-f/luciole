# Delivery luciole-deps-diet @ ff61a51f40ee9927c02f89d13e841ed4042b91ba (round 1)

Status: DONE
Summary: luciole no longer installs what an app does not use. Grammars (16), MathJax/resvg, SQLite and xterm (3) become optional peers (exact devDependencies kept for the workspace); `typescript` 7 moves to devDependencies (nothing in `src` imports it; `luciole init` already copies devDependencies to the app); remaining ranges become `^`. `luciole/math` and `luciole/grammars` load their packages by dynamic `import()` through `src/optional.ts`; the web builds `assertInstalled` theirs before bundling. A missing package gives "<feature> needs the optional package X, which is not installed: run `bun add X`". Decisions recorded in `docs/DEPENDENCIES.md`.

| Dependency | Class | Before → after | Reason |
| --- | --- | --- | --- |
| @opentui/core, keymap, react | every app | exact → `^` | rendering engine |
| @tanstack/react-router, react-reconciler | every app | exact → `^` | router and reconciler of every app |
| react-server-dom-webpack, zod | every app | exact → `^` | Flight (RSC), action/args schemas |
| marked | every app | exact → `^` | `<Markdown>` is part of the client |
| @typescript/typescript6 | build tool, runtime | exact → `^` | `luciole build` reads the app AST with it |
| typescript 7 | app tool | dependency → devDependency | never imported by luciole; only `tsc --noEmit` uses it |
| tree-sitter-* (13), @tree-sitter-grammars/* (3) | optional | dependency → optional peer | only `luciole/grammars` |
| mathjax-full, @resvg/resvg-wasm | optional | dependency → optional peer | only `luciole/math` |
| @sqlite.org/sqlite-wasm | optional | dependency → optional peer | web target's Worker only (server cache uses `bun:sqlite`) |
| @xterm/xterm, addon-fit, addon-webgl | optional | dependency → optional peer | web runtime bundle only |

Deviations from the brief: none. `src/cache/**` imports no optional package (it uses `bun:sqlite`), so it is untouched. `src/build.ts` and its web build are untouched: the check lives in `web/build.ts` and `web/server-build.ts`.
Verification: `bun install --frozen-lockfile`, `bun run check` (25/25), `bun run lint`, `bun run format:check` pass on ff61a51; `bun pm pack --dry-run` in packages/luciole passes (234 files).
Tests: tests/optional.test.ts, tests/math.test.ts, tests/grammars.test.tsx, tests/build.test.ts, tests/web-routes.test.ts, tests/web-sqlite.test.ts, tests/web-async-context.test.ts, tests/pack-check.test.ts, tests/markdown.test.tsx, tests/cache-build.test.ts, tests/build-names.test.ts, tests/notes.test.tsx, tests/forge-editor.test.tsx, tests/binary.test.ts, tests/harness-session.test.ts
Risks: `grammars.ts` now uses top-level await (dynamic `import(..., {with:{type:"file"}})`, verified to bundle). An external app installing luciole must now add the optional packages it uses (`bun add mathjax-full @resvg/resvg-wasm`, grammars, web). Consumers inside the workspace (harness, editor, notes) get them hoisted from luciole's devDependencies. I did not run the whole suite.
Merge notes: bun.lock and packages/luciole/package.json will conflict with any other dependency change.
