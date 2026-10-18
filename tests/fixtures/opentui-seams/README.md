`plain-frame.json` is the historical Writable/feed capture of OpenTUI v0.5.12 (2026-10-16) with the
existing wasm32-wasi patch, before the renderer seams. The fixture is an 8×2
renderer, mouse enabled, one 8×1 `TextRenderable` containing `BASE`, white default
foreground and transparent background. Capture ends after one render and idle,
before destruction. The integration test checks both the unchanged render path
and an empty one-segment encoder plan against these exact bytes.
