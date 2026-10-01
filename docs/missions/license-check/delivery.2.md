# Delivery license-check @ f02764c756cbf26b01278e6880dc4b0c63043309 (round 2)

Status: DONE
Summary: Round-1 triage done. SPDX expressions go through spdx-expression-parse (new devDependency via the catalog, with @types) and the tree is evaluated (OR best branch, AND all; unparsable or empty = blocking). Peers are followed at every level, workspace edges are followed, a required dependency that does not resolve fails the check, absent optional dependencies are reported grouped by parent. Each shipped package prints its full table. docs lists both consumers of sharp (examples/files and the root devDependency) and the installed-only limit.
Deviations from the brief: spdx-expression-parse 5.0.0 and @types/spdx-expression-parse 4.0.0 added to the root catalog and devDependencies (bun.lock updated), as the triage asked; no existing version changed.
Verification: bun run check, bun run lint, bun run format:check → pass; bun run licenses → exit 0.
Tests: tests/licenses.test.ts
Risks: only installed optional dependencies are read (Linux/Windows binaries are listed absent); run on Linux when CI wires it.
Merge notes: bun.lock and root package.json (catalog + devDependencies) changed.
Findings addressed: SPDX parsing (fixtures for parentheses, empty, unparsable); peers below the root (test); unresolved required = error, workspace edges followed, absent optional reported (tests; tree proven complete by resolution rather than bun.lock); sharp docs; per-package table pasted below; tests added in tests/licenses.test.ts.

## Output of bun run licenses

```
luciole (shipped): 137 packages
  package                                          license       class
  @jridgewell/gen-mapping@0.3.13                   MIT           permissive
  @jridgewell/resolve-uri@3.1.2                    MIT           permissive
  @jridgewell/source-map@0.3.11                    MIT           permissive
  @jridgewell/sourcemap-codec@1.6.0                MIT           permissive
  @jridgewell/trace-mapping@0.3.31                 MIT           permissive
  @opentui/core@0.5.12                             MIT           permissive
  @opentui/core-darwin-arm64@0.5.12                MIT           permissive
  @opentui/keymap@0.5.12                           MIT           permissive
  @opentui/react@0.5.12                            MIT           permissive
  @resvg/resvg-wasm@2.6.2                          MPL-2.0       notice
  @sqlite.org/sqlite-wasm@3.53.4-build1            Apache-2.0    permissive
  @tanstack/history@1.162.4                        MIT           permissive
  @tanstack/react-router@1.170.38                  MIT           permissive
  @tanstack/react-store@0.11.1                     MIT           permissive
  @tanstack/router-core@1.171.32                   MIT           permissive
  @tanstack/store@0.11.1                           MIT           permissive
  @tree-sitter-grammars/tree-sitter-lua@0.4.1      MIT           permissive
  @tree-sitter-grammars/tree-sitter-toml@0.7.0     MIT           permissive
  @tree-sitter-grammars/tree-sitter-yaml@0.7.1     MIT           permissive
  @types/estree@1.0.9                              MIT           permissive
  @types/json-schema@7.0.15                        MIT           permissive
  @types/node@26.6.2                               MIT           permissive
  @typescript/typescript-darwin-arm64@7.0.2        Apache-2.0    permissive
  @typescript/typescript6@6.0.2                    Apache-2.0    permissive
  @webassemblyjs/ast@1.14.1                        MIT           permissive
  @webassemblyjs/floating-point-hex-parser@1.13.2  MIT           permissive
  @webassemblyjs/helper-api-error@1.13.2           MIT           permissive
  @webassemblyjs/helper-buffer@1.14.1              MIT           permissive
  @webassemblyjs/helper-numbers@1.13.2             MIT           permissive
  @webassemblyjs/helper-wasm-bytecode@1.13.2       MIT           permissive
  @webassemblyjs/helper-wasm-section@1.14.1        MIT           permissive
  @webassemblyjs/ieee754@1.13.2                    MIT           permissive
  @webassemblyjs/leb128@1.13.2                     Apache-2.0    permissive
  @webassemblyjs/utf8@1.13.2                       MIT           permissive
  @webassemblyjs/wasm-edit@1.14.1                  MIT           permissive
  @webassemblyjs/wasm-gen@1.14.1                   MIT           permissive
  @webassemblyjs/wasm-opt@1.14.1                   MIT           permissive
  @webassemblyjs/wasm-parser@1.14.1                MIT           permissive
  @webassemblyjs/wast-printer@1.14.1               MIT           permissive
  @xmldom/xmldom@0.9.10                            MIT           permissive
  @xterm/addon-fit@0.11.0                          MIT           permissive
  @xterm/addon-webgl@0.19.0                        MIT           permissive
  @xterm/xterm@6.0.0                               MIT           permissive
  @xtuc/ieee754@1.2.0                              BSD-3-Clause  permissive
  @xtuc/long@4.2.2                                 Apache-2.0    permissive
  acorn@8.18.0                                     MIT           permissive
  acorn-loose@8.5.2                                MIT           permissive
  ajv@8.20.0                                       MIT           permissive
  ajv-formats@3.0.1                                MIT           permissive
  ajv-keywords@5.1.0                               MIT           permissive
  ansi-regex@6.3.0                                 MIT           permissive
  baseline-browser-mapping@2.11.25                 Apache-2.0    permissive
  browserslist@4.29.0                              MIT           permissive
  buffer-from@1.1.2                                MIT           permissive
  bun-ffi-structs@0.3.1                            MIT           permissive
  caniuse-lite@1.0.30001810                        CC-BY-4.0     permissive
  chrome-trace-event@1.0.4                         MIT           permissive
  commander@13.1.0                                 MIT           permissive
  commander@2.20.3                                 MIT           permissive
  cookie-es@3.1.1                                  MIT           permissive
  diff@9.0.0                                       BSD-3-Clause  permissive
  electron-to-chromium@1.5.434                     ISC           permissive
  emoji-regex@10.6.0                               MIT           permissive
  enhanced-resolve@5.25.1                          MIT           permissive
  es-module-lexer@2.3.2                            MIT           permissive
  escalade@3.2.0                                   MIT           permissive
  esm@3.2.25                                       MIT           permissive
  events@3.3.0                                     MIT           permissive
  fast-deep-equal@3.1.3                            MIT           permissive
  fast-uri@3.1.8                                   BSD-3-Clause  permissive
  get-east-asian-width@1.7.0                       MIT           permissive
  graceful-fs@4.2.11                               ISC           permissive
  has-flag@4.0.0                                   MIT           permissive
  isbot@5.2.2                                      Unlicense     permissive
  jest-worker@27.5.1                               MIT           permissive
  json-schema-traverse@1.0.0                       MIT           permissive
  marked@17.0.1                                    MIT           permissive
  mathjax-full@3.2.2                               Apache-2.0    permissive
  merge-stream@2.0.0                               MIT           permissive
  mhchemparser@4.2.1                               Apache-2.0    permissive
  mime-db@1.54.0                                   MIT           permissive
  minimizer-webpack-plugin@5.11.0                  MIT           permissive
  mj-context-menu@0.6.1                            Apache-2.0    permissive
  neo-async@2.6.2                                  MIT           permissive
  node-addon-api@8.9.2                             MIT           permissive
  node-gyp-build@4.8.4                             MIT           permissive
  node-releases@2.0.56                             MIT           permissive
  picocolors@1.1.1                                 ISC           permissive
  react@19.3.0                                     MIT           permissive
  react-devtools-core@7.0.1                        MIT           permissive
  react-dom@19.3.0                                 MIT           permissive
  react-reconciler@0.33.0                          MIT           permissive
  react-server-dom-webpack@19.3.0                  MIT           permissive
  require-from-string@2.0.2                        MIT           permissive
  scheduler@0.27.0                                 MIT           permissive
  scheduler@0.28.0                                 MIT           permissive
  schema-utils@4.5.0                               MIT           permissive
  seroval@1.6.7                                    MIT           permissive
  seroval-plugins@1.6.7                            MIT           permissive
  shell-quote@1.10.0                               MIT           permissive
  source-map@0.6.1                                 BSD-3-Clause  permissive
  source-map-support@0.5.21                        MIT           permissive
  speech-rule-engine@4.1.4                         Apache-2.0    permissive
  string-width@7.2.0                               MIT           permissive
  strip-ansi@7.2.0                                 MIT           permissive
  strip-ansi@7.1.2                                 MIT           permissive
  supports-color@8.1.1                             MIT           permissive
  tapable@2.3.3                                    MIT           permissive
  terser@5.51.2                                    BSD-2-Clause  permissive
  tree-sitter-bash@0.25.1                          MIT           permissive
  tree-sitter-c@0.24.1                             MIT           permissive
  tree-sitter-c@0.23.6                             MIT           permissive
  tree-sitter-cpp@0.23.4                           MIT           permissive
  tree-sitter-css@0.25.0                           MIT           permissive
  tree-sitter-go@0.25.0                            MIT           permissive
  tree-sitter-html@0.23.2                          MIT           permissive
  tree-sitter-java@0.23.5                          MIT           permissive
  tree-sitter-javascript@0.23.1                    MIT           permissive
  tree-sitter-json@0.24.8                          MIT           permissive
  tree-sitter-php@0.24.2                           MIT           permissive
  tree-sitter-python@0.25.0                        MIT           permissive
  tree-sitter-ruby@0.23.1                          MIT           permissive
  tree-sitter-rust@0.24.0                          MIT           permissive
  tree-sitter-typescript@0.23.2                    MIT           permissive
  typescript@7.0.2                                 Apache-2.0    permissive
  typescript@6.0.3                                 Apache-2.0    permissive
  undici-types@8.9.0                               MIT           permissive
  update-browserslist-db@1.3.3                     MIT           permissive
  use-sync-external-store@1.7.0                    MIT           permissive
  watchpack@2.5.2                                  MIT           permissive
  web-tree-sitter@0.25.10                          MIT           permissive
  webpack@5.111.1                                  MIT           permissive
  webpack-sources@3.5.1                            MIT           permissive
  wicked-good-xpath@1.3.0                          MIT           permissive
  ws@7.5.13                                        MIT           permissive
  ws@8.21.3                                        MIT           permissive
  zod@4.6.5                                        MIT           permissive
  absent optional, from @opentui/core: @opentui/core-darwin-x64, @opentui/core-linux-arm64, @opentui/core-linux-arm64-musl, @opentui/core-linux-x64, @opentui/core-linux-x64-musl, @opentui/core-win32-arm64, @opentui/core-win32-x64
  absent optional, from @opentui/keymap: @opentui/solid, solid-js
  absent optional, from web-tree-sitter: @types/emscripten
  absent optional, from typescript: @typescript/typescript-aix-ppc64, @typescript/typescript-darwin-x64, @typescript/typescript-freebsd-arm64, @typescript/typescript-freebsd-x64, @typescript/typescript-linux-arm, @typescript/typescript-linux-arm64, @typescript/typescript-linux-loong64, @typescript/typescript-linux-mips64el, @typescript/typescript-linux-ppc64, @typescript/typescript-linux-riscv64, @typescript/typescript-linux-s390x, @typescript/typescript-linux-x64, @typescript/typescript-netbsd-arm64, @typescript/typescript-netbsd-x64, @typescript/typescript-openbsd-arm64, @typescript/typescript-openbsd-x64, @typescript/typescript-sunos-x64, @typescript/typescript-win32-arm64, @typescript/typescript-win32-x64
  absent optional, from ws: bufferutil, utf-8-validate
  absent optional, from @tree-sitter-grammars/tree-sitter-lua: tree-sitter
  absent optional, from @tree-sitter-grammars/tree-sitter-toml: tree-sitter
  absent optional, from @tree-sitter-grammars/tree-sitter-yaml: tree-sitter
  absent optional, from tree-sitter-bash: tree-sitter
  absent optional, from tree-sitter-c: tree-sitter
  absent optional, from tree-sitter-cpp: tree-sitter
  absent optional, from tree-sitter-css: tree-sitter
  absent optional, from tree-sitter-go: tree-sitter
  absent optional, from tree-sitter-html: tree-sitter
  absent optional, from tree-sitter-java: tree-sitter
  absent optional, from tree-sitter-javascript: tree-sitter
  absent optional, from tree-sitter-json: tree-sitter
  absent optional, from tree-sitter-php: tree-sitter
  absent optional, from tree-sitter-python: tree-sitter
  absent optional, from tree-sitter-ruby: tree-sitter
  absent optional, from tree-sitter-rust: tree-sitter
  absent optional, from tree-sitter-typescript: tree-sitter

@luciole/flow (shipped): 23 packages
  package                                    license       class
  @opentui/core@0.5.12                       MIT           permissive
  @opentui/core-darwin-arm64@0.5.12          MIT           permissive
  @opentui/keymap@0.5.12                     MIT           permissive
  @opentui/react@0.5.12                      MIT           permissive
  @typescript/typescript-darwin-arm64@7.0.2  Apache-2.0    permissive
  ansi-regex@6.3.0                           MIT           permissive
  bun-ffi-structs@0.3.1                      MIT           permissive
  diff@9.0.0                                 BSD-3-Clause  permissive
  emoji-regex@10.6.0                         MIT           permissive
  get-east-asian-width@1.7.0                 MIT           permissive
  marked@17.0.1                              MIT           permissive
  react@19.3.0                               MIT           permissive
  react-devtools-core@7.0.1                  MIT           permissive
  react-reconciler@0.33.0                    MIT           permissive
  scheduler@0.27.0                           MIT           permissive
  shell-quote@1.10.0                         MIT           permissive
  string-width@7.2.0                         MIT           permissive
  strip-ansi@7.2.0                           MIT           permissive
  strip-ansi@7.1.2                           MIT           permissive
  typescript@7.0.2                           Apache-2.0    permissive
  web-tree-sitter@0.25.10                    MIT           permissive
  ws@7.5.13                                  MIT           permissive
  ws@8.21.3                                  MIT           permissive
  absent optional, from @opentui/core: @opentui/core-darwin-x64, @opentui/core-linux-arm64, @opentui/core-linux-arm64-musl, @opentui/core-linux-x64, @opentui/core-linux-x64-musl, @opentui/core-win32-arm64, @opentui/core-win32-x64
  absent optional, from @opentui/keymap: @opentui/solid, solid-js
  absent optional, from web-tree-sitter: @types/emscripten
  absent optional, from typescript: @typescript/typescript-aix-ppc64, @typescript/typescript-darwin-x64, @typescript/typescript-freebsd-arm64, @typescript/typescript-freebsd-x64, @typescript/typescript-linux-arm, @typescript/typescript-linux-arm64, @typescript/typescript-linux-loong64, @typescript/typescript-linux-mips64el, @typescript/typescript-linux-ppc64, @typescript/typescript-linux-riscv64, @typescript/typescript-linux-s390x, @typescript/typescript-linux-x64, @typescript/typescript-netbsd-arm64, @typescript/typescript-netbsd-x64, @typescript/typescript-openbsd-arm64, @typescript/typescript-openbsd-x64, @typescript/typescript-sunos-x64, @typescript/typescript-win32-arm64, @typescript/typescript-win32-x64
  absent optional, from ws: bufferutil, utf-8-validate

@luciole/editor (shipped): 22 packages
  package                                    license       class
  @opentui/core@0.5.12                       MIT           permissive
  @opentui/core-darwin-arm64@0.5.12          MIT           permissive
  @opentui/react@0.5.12                      MIT           permissive
  @typescript/typescript-darwin-arm64@7.0.2  Apache-2.0    permissive
  ansi-regex@6.3.0                           MIT           permissive
  bun-ffi-structs@0.3.1                      MIT           permissive
  diff@9.0.0                                 BSD-3-Clause  permissive
  emoji-regex@10.6.0                         MIT           permissive
  get-east-asian-width@1.7.0                 MIT           permissive
  marked@17.0.1                              MIT           permissive
  react@19.3.0                               MIT           permissive
  react-devtools-core@7.0.1                  MIT           permissive
  react-reconciler@0.33.0                    MIT           permissive
  scheduler@0.27.0                           MIT           permissive
  shell-quote@1.10.0                         MIT           permissive
  string-width@7.2.0                         MIT           permissive
  strip-ansi@7.2.0                           MIT           permissive
  strip-ansi@7.1.2                           MIT           permissive
  typescript@7.0.2                           Apache-2.0    permissive
  web-tree-sitter@0.25.10                    MIT           permissive
  ws@7.5.13                                  MIT           permissive
  ws@8.21.3                                  MIT           permissive
  absent optional, from @opentui/core: @opentui/core-darwin-x64, @opentui/core-linux-arm64, @opentui/core-linux-arm64-musl, @opentui/core-linux-x64, @opentui/core-linux-x64-musl, @opentui/core-win32-arm64, @opentui/core-win32-x64
  absent optional, from web-tree-sitter: @types/emscripten
  absent optional, from typescript: @typescript/typescript-aix-ppc64, @typescript/typescript-darwin-x64, @typescript/typescript-freebsd-arm64, @typescript/typescript-freebsd-x64, @typescript/typescript-linux-arm, @typescript/typescript-linux-arm64, @typescript/typescript-linux-loong64, @typescript/typescript-linux-mips64el, @typescript/typescript-linux-ppc64, @typescript/typescript-linux-riscv64, @typescript/typescript-linux-s390x, @typescript/typescript-linux-x64, @typescript/typescript-netbsd-arm64, @typescript/typescript-netbsd-x64, @typescript/typescript-openbsd-arm64, @typescript/typescript-openbsd-x64, @typescript/typescript-sunos-x64, @typescript/typescript-win32-arm64, @typescript/typescript-win32-x64
  absent optional, from ws: bufferutil, utf-8-validate

non-shipped (private workspaces, never fail the check):
  @anthropic-ai/claude-agent-sdk@0.3.283  SEE LICENSE IN README.md  blocking  via @luciole/harness, @luciole-examples/studio, @luciole-examples/coder
  @img/sharp-libvips-darwin-arm64@1.3.3  LGPL-3.0-or-later  notice  via @luciole-examples/files

OK: no blocking licence in a shipped tree
```
