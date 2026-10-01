# Delivery license-check @ cddfc38b0aad8d385a82f63f384d368afc55e3a0 (round 1)

Status: DONE
Summary: `bun run licenses` (scripts/licenses.ts) walks the production tree (dependencies, optionalDependencies, resolved peers) of luciole, @luciole/flow and @luciole/editor from the installed node_modules, classifies SPDX expressions (OR best, AND worst) and exits 1 on a blocking licence. Private workspaces (harness, desktop, examples) are listed apart as non-shipped, never failing. Only blocker-class finding: none in shipped trees. MPL-2.0 @resvg/resvg-wasm is the one non-permissive shipped licence (notice: THIRD_PARTY_NOTICES.md). sharp/libvips (LGPL) is only a dependency of examples/files; the agent SDK (proprietary) only of private harness.
Deviations from the brief: none. The test is tests/licenses.test.ts (repo's test dir). Checks are scoped to node_modules as installed (this platform's optional binaries only).
Verification: bun run check, bun run lint, bun run format:check → pass; bun run licenses → exit 0.
Tests: tests/licenses.test.ts
Risks: only the installed platform's optional dependencies are seen; run on Linux CI too when a release mission wires it.
Merge notes: root package.json gains "license" and a "licenses" script; docs/DEPENDENCIES.md gains a final section.

## Output of bun run licenses

```
luciole (shipped): 71 packages
  MIT 59, Apache-2.0 9, MPL-2.0 1, BSD-3-Clause 1, Unlicense 1
  package                  license  class
  @resvg/resvg-wasm@2.6.2  MPL-2.0  notice

@luciole/flow (shipped): 16 packages
  MIT 15, BSD-3-Clause 1
  all permissive

@luciole/editor (shipped): 15 packages
  MIT 14, BSD-3-Clause 1
  all permissive

non-shipped (private workspaces, never fail the check):
  @anthropic-ai/claude-agent-sdk@0.3.283  SEE LICENSE IN README.md  blocking  via @luciole/harness
  @img/sharp-libvips-darwin-arm64@1.3.3  LGPL-3.0-or-later  notice  via @luciole-examples/files

OK: no blocking licence in a shipped tree
```
