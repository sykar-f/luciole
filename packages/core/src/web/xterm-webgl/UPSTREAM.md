# Vendored xterm.js WebGL addon

`addon/` is `@xterm/addon-webgl` 0.19.0, upstream commit
`f447274f430fd22513f6adbf9862d19524471c04`. `xterm/` contains its transitive
source imports from `@xterm/xterm` 6.0.0, including type dependencies and the
upstream VS Code utilities. Both packages ship their MIT license in `LICENSE`.
The combined notice keeps the addon’s 2018 xterm.js authors copyright and
xterm’s 2017–2019 xterm.js authors, 2014–2016 SourceLair Private Company,
and 2012–2013 Christopher Jeffrey copyrights, with their shared MIT terms.
The VS Code files retain their original copyright notices.

Mechanical adaptations: internal `browser/`, `common/`, and `vs/` imports use
relative paths under `xterm/`; `vs/nls` resolves to xterm's `vs/patches/nls.ts`.
Each upstream file has a first-line `@ts-nocheck` because these sources use
xterm's compiler options and internal types. Lint and formatting exclude these
two directories; product additions under `pixel-scroll/` use project checks.
No glyph shader or cell layout changed.

Product changes are confined to `addon/WebglAddon.ts` and
`addon/WebglRenderer.ts`: the addon exposes its renderer-owned `pixels` API;
the renderer supplies checkpoint rasterization and redraw composition through
`PixelCompositor`, with cursor-free captures and a separate retained cursor tile composed afterward.
The WebGL canvas has an explicit `xterm-webgl-layer` class so context-loss
listeners do not attach to the 2D link overlay. The compositor retains a whole
validated GPU frame as well as the region checkpoint, so aborts and synchronized
output timeouts cannot publish half-prepared chrome or moved rectangles. A grid
signature gates canonical recapture and release. These modules and their tests
are the proposed upstream seam; the OSC protocol remains a separate consumer.

To compare: remove the first line of each vendored file and normalize the
relative import prefixes back to xterm's source aliases. All files other than
the two named addon files then match the corresponding npm package sources.
Desktop and the website's capture terminals continue using the npm addon.
