# OpenTUI capability inventory for an agent TUI (airtty)

Researched 2026-09-26. Everything below was checked against the **installed typings** in
`/Users/sykar-f/workdir/drafts/airtty/node_modules/@opentui/*` (abbreviated `NM/` below), then filled in from
opentui.com/docs and the GitHub repo.

## 1. Packages, version, renderer model

| Package           | Version                                         | Notes                                                                                                                                                                                                                                                       |
| ----------------- | ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@opentui/core`   | **0.5.12** (catalog pin in root `package.json`) | Native Zig core via FFI, with prebuilt `@opentui/core-<os>-<arch>` packages. Deps: `marked 17.0.1`, `diff 9.0.0`, `string-width`, `bun-ffi-structs`. Peer dep: `web-tree-sitter 0.25.10`. Runs on Bun >= 1.3, or on Node >= 26.4 with `--experimental-ffi`. |
| `@opentui/react`  | 0.5.12                                          | React reconciler; the repo uses `react-reconciler 0.33`.                                                                                                                                                                                                    |
| `@opentui/keymap` | 0.5.12                                          | Layered keymap engine with React bindings.                                                                                                                                                                                                                  |

- The repo **moved from `sst/opentui` to `anomalyco/opentui`**. `gh repo view sst/opentui` resolves to `anomalyco/opentui`, which has about 13.4k stars. The `repository` field in `NM/core/package.json` also points there. 0.5.12 (2026-09-22) is the latest release; releases ship roughly weekly (0.5.8 → 0.5.12 in about a month).
- Docs: https://opentui.com/docs. Useful pages: `/core-concepts/{renderer,renderables,layout,interaction,keyboard,text-and-cells,colors,lifecycle,clipboard,notifications,console,testing}` and `/components/*`. There is also an agent skill: `npx skills add anomalyco/opentui --skill opentui`.
- Production reference: OpenCode's TUI is built on OpenTUI (Solid bindings).
- Other repo packages that are not installed here: `solid`, `ssh`, `three`, `qrcode` (`@opentui/qrcode/react` → `registerQRCode()`), `web`.

### CliRenderer (`NM/core/renderer.d.ts`)

`createCliRenderer(config)` accepts the following `CliRendererConfig` options:

- **Streams and size:** `stdin`, `stdout`, `width`, `height`, `remote`, `forwardEnvKeys`.
  - With a non-`process.stdout` stream, output goes through a `NativeSpanFeed`. This is what airtty's web platform does in `packages/airtty/src/web/platform/run.tsx:178`.
  - Call `renderer.resize(w,h)` for external resizes. SIGWINCH is only automatic on `process.stdout`.
- **Screen:** `screenMode: "alternate-screen" | "main-screen" | "split-footer"`, `footerHeight` (default 12), `externalOutputMode: "capture-stdout" | "passthrough"`, `clearOnShutdown`, `backgroundColor`.
- **Split-footer model (Claude Code-like inline UI):**
  - A live footer is pinned at the bottom of the _main_ screen. Finished content is committed into real terminal scrollback.
  - APIs: `renderer.writeToScrollback(ctx => ({root, width, height, startOnNewLine, trailingNewline}))`, and `renderer.createScrollbackSurface()` → `{root, renderContext, render(), settle(), commitRows(start,end), destroy()}` for _streaming_ a Markdown or Code renderable into scrollback row by row. Also `resetSplitFooterForReplay()`.
  - Examples: `packages/examples/src/split-footer-streaming-demo.ts`, `split-mode-demo.ts`, `split-footer-image-demo.ts`.
- **Loop:**
  - `targetFps`, `maxFps`, `debounceDelay`, `useThread` (render on a native thread; airtty web forces it off), `gatherStats`, `maxStatSamples`, `memorySnapshotInterval`, `clock`.
  - Rendering is **demand-driven** by default: tree mutations call `requestRender()`. `start()`/`pause()` switch to continuous rendering. `requestLive()`/`dropLive()` are ref-counted live mode (timelines use it). Also `suspend()`/`resume()` (e.g. to shell out to $EDITOR), `idle()`, `getStats()`.
- **Input:**
  - `useMouse` (default on), `enableMouseMovement`, `autoFocus` (a left click focuses the nearest focusable).
  - `useKittyKeyboard: {disambiguate, alternateKeys, events, allKeysAsEscapes, reportText}` (defaults: disambiguate and alternateKeys on).
  - `exitOnCtrlC`, `exitSignals`, `prependInputHandlers`, `stdinParserMaxBufferBytes`.
- **Console overlay:** `consoleMode: "console-overlay" | "disabled"`, `consoleOptions` (position, sizePercent, colors, keyBindings, `onCopySelection`), `openConsoleOnError`. `renderer.console.show()/toggle()` captures `console.log` into an in-app pane (`NM/core/console.d.ts`).
- **Other:**
  - `postProcessFns` for buffer effects (`NM/core/post/*`).
  - `kittyImageTransport: "raw" | "zlib" | "file"`.
  - `onDestroy`. `destroy()` must be called on every non-Ctrl-C exit path.
- **Runtime methods:**
  - `setTerminalTitle`, `triggerNotification(msg,title)` (OSC 9/99/777 when supported), `setCursorStyle/Position/Color`, `setMousePointer(cssCursor)`.
  - `copyToClipboardOSC52`, `isOsc52Supported`, `getPalette()` (OSC 4/10/11 terminal palette), `themeMode` / `waitForThemeMode()` (dark/light detection with a `theme_mode` event), `capabilities`, `getLinkAt(x,y)`, `hitTest`, `toggleDebugOverlay()`.
- **Events (`CliRenderEvents`):** `resize, frame, render:error, handler:error, external_output, focus, blur, focused_renderable, focused_editor, theme_mode, palette, capabilities, selection, destroy`.
- **Capability detection (`TerminalCapabilities` in `NM/core/types.d.ts`):** `kitty_keyboard, kitty_graphics, sixel, rgb, ansi256, unicode width method, sync, bracketed_paste, hyperlinks, osc52(_support), notifications, focus_tracking, color_scheme_updates, explicit_width, scaled_text, multiplexer (tmux/zellij/screen), remote, terminal {name, version}`. Capabilities arrive asynchronously; replies are accepted for about 5 s.

## 2. Components and renderables

The React catalogue lives in `NM/react/src/components/index.d.ts`: `box, text, code, diff, markdown, input, select, textarea, scrollbox, ascii-font, tab-select, line-number, image`, plus text modifiers `span, b/strong, i/em, u, br, a(href)`.

Core-only renderables (usable through `extend()`): `TextTable`, `Slider`, `ScrollBar`, `FrameBuffer`, `EmbeddedTerminal`, `TimeToFirstDraw`, `Slot`.

### Box (`renderables/Box.d.ts`)

- Props: `backgroundColor`, `border` (`true` or a list of sides), `borderStyle` (`single | double | rounded | heavy`), `borderColor`, `focusedBorderColor`, `customBorderChars`.
- Titles: `title`, `titleColor`, `titleAlignment`, `bottomTitle`, `bottomTitleAlignment`.
- Layout and behaviour: `shouldFill`, `focusable`, `gap`, `rowGap`, `columnGap`, plus all layout props.

### Text / TextNode (`Text.d.ts`, `TextNode.d.ts`, `TextBufferRenderable.d.ts`)

- `content` is a string or `StyledText`.
- Props: `fg`, `bg`, `attributes` (`TextAttributes.BOLD|DIM|ITALIC|UNDERLINE|BLINK|INVERSE|HIDDEN|STRIKETHROUGH`), `wrapMode: none|char|word`, `textAlign`, `truncate`, `selectable` (default true), `selectionBg/Fg`, `tabIndicator`.
- Spans nest and inherit style. `link: {url}` / `<a href>` emits OSC 8 hyperlinks.
- Template helper: ``t`${bold("x")} ${fg("#f00")("y")}` `` (`lib/styled-text.d.ts`).
- Text is stored in a native TextBuffer, so it is not a JS string per cell.

### Input (`Input.d.ts`)

- Single-line. Extends Textarea, so it has the same keybindings and undo.
- Props: `value`, `placeholder`, `maxLength`, `minLength`.
- React events: `onInput`, `onChange`, `onSubmit(value)`.

### Textarea (`Textarea.d.ts`, `EditBufferRenderable.d.ts`)

Multi-line editor on a native rope `EditBuffer` with grapheme-aware editing and word/visual-line wrap.

- **Props:**
  - Content and styling: `initialValue`, `placeholder` (string or StyledText), `placeholderColor`, `textColor`, `backgroundColor`, `focusedBackgroundColor`, `focusedTextColor`.
  - Cursor and scrolling: `cursorColor`, `cursorStyle {style: block|line|underline, blinking}`, `wrapMode`, `scrollMargin`, `scrollSpeed`.
  - Selection and highlighting: `selectionBg/Fg`, `selectionOccupancy`, `syntaxStyle` (for highlights).
- **Keybindings:** `keyBindings: KeyBinding<TextareaAction>[]` and `keyAliasMap`. Actions: move, select, line/visual-line/buffer home/end, word move and delete, delete-line and -to-start/end, backspace, delete, newline, **undo**, **redo**, select-all, submit. Defaults are exported as `defaultTextareaKeyBindings`.
- **Events:** `onSubmit`, `onContentChange`, `onCursorChange({line, visualColumn})`, `onKeyDown`, `onPaste`.
- **Imperative API:**
  - Editing: `insertText`, `setText` (resets history), `replaceText` (undoable), `deleteRange`, `getTextRange`.
  - Cursor: `setCursor(row,col)`, `cursorOffset`, `logicalCursor`, `visualCursor`.
  - Highlights: `addHighlightByCharRange`, `removeHighlightsByRef`.
  - Text: `plainText`.
- **`extmarks`** (`lib/extmarks.d.ts`): ranged marks with `virtual`, `styleId`, `data`, and type IDs. The code warns that this is "simulated, use with caution". This is the building block for @-mention chips or pasted-text placeholders. A PR for clickable extmarks is pending (#809).
- **`traits`** `{capture: ["escape"|"navigate"|"submit"|"tab"], suspend, status}`: tells host keymaps which keys the editor wants to own.
- There is **no built-in autocomplete popup**. You build it yourself (see §6).

### Select / TabSelect (`Select.d.ts`, `TabSelect.d.ts`)

- **Select:** vertical list of `{name, description, value}`.
  - Behaviour: `selectedIndex`, `wrapSelection`, `showDescription`, `showScrollIndicator`, `showSelectionIndicator`, `itemSpacing`, `fastScrollStep`, `font` (ASCII fonts).
  - Styling: a full color set.
  - Keys and events: `keyBindings` for move-up/down(-fast)/select-current; `onChange(index, option)` and `onSelect`.
  - It renders a flat list. There is **no filtering and no custom row rendering**.
- **TabSelect:** horizontal tabs with `tabWidth`, `showUnderline`, and `showScrollArrows`.

### ScrollBox (`ScrollBox.d.ts`)

- Props: `scrollY` (default true), `scrollX`.
- **`stickyScroll` + `stickyStart: "bottom"`**: follows the tail and pauses when the user scrolls away. It re-arms when the user returns to the bottom.
- **`viewportCulling`** (default **true**): only visible children render. Off-screen children skip `renderBefore/After`.
- Custom scroll: `scrollAcceleration` (`LinearScrollAccel`, `MacOSScrollAccel`).
- Styling of the inner parts: `rootOptions`, `wrapperOptions`, `viewportOptions`, `contentOptions`, `scrollbarOptions`, `verticalScrollbarOptions`, `horizontalScrollbarOptions`.
- API: `scrollTo`, `scrollBy(delta, "absolute"|"viewport"|"content"|"step")`, `scrollChildIntoView(id)` (nearest), `scrollTop`, `scrollHeight`.
- When focused, it handles arrows (1/5 of the viewport), PgUp/PgDn (1/2), and Home/End. It also auto-scrolls during a drag selection.

### Code (`Code.d.ts`)

- Tree-sitter highlighting runs in a **worker** (`parser.worker.js`).
- Props: `content`, `filetype`, `syntaxStyle` (required), `treeSitterClient`, `conceal`, `drawUnstyledText` (shows plain text until highlights arrive), `baseHighlight`.
- **`streaming`** plus `updateStreamingPreview(content, styledText)`.
- Hooks: `onHighlight` to post-process highlights, `onChunks` to post-process styled chunks.
- State: `isHighlighting`, `highlightingDone`.
- **Bundled grammars are only javascript, typescript, markdown, markdown_inline and zig** (`NM/core/assets/*`). A `diff` filetype also appears in the bundle. Add others with `addDefaultParsers([{filetype, aliases, wasm: url|path, queries: {highlights: [...], injections}}])` or `treeSitterClient.addFiletypeParser(...)`. Wasm and queries can be URLs, which are downloaded and cached in the data path. Issue #1434 asks for a way to replace the default set.
- `SyntaxStyle.fromStyles({keyword: {fg, bold}, ...})` or `SyntaxStyle.fromTheme([{scope: [...], style: {...}}])` (VS Code-like theme tokens).

### Markdown (`Markdown.d.ts`, `markdown-parser.d.ts`)

- Built on `marked`, with an **incremental parser** (`parseMarkdownIncremental`): unchanged tokens keep their identity and only the trailing block is re-rendered.
- **`streaming: true`** keeps the last block "unstable" while you append. Set it to false at the end to finalize.
- Props: `conceal` (hides `**`, `#` and similar markers), `concealCode`, `fg`, `bg`, `syntaxStyle`, `treeSitterClient`.
- Fenced code blocks render through CodeRenderable, with fence info-string normalisation (`tsx` → `typescriptreact`).
- Tables use TextTable (`tableOptions`: style `grid|columns`, widthMode, borders, and so on).
- Custom rendering: `renderNode(token, ctx)` to override any token (it has `ctx.defaultRender()`), and `createMarkdownCodeBlockRenderer({mermaid: ..., diff: ...})` for per-language fences.
- `internalBlockMode: "coalesced" | "top-level"` (the split-footer demo uses top-level).
- Style scopes include `markup.heading.1`, `markup.list`, and so on.

### Diff (`Diff.d.ts`)

- Input is a unified-diff string, and **only `patches[0]` is shown**, so split multi-file patches first.
- `view: "unified" | "split"`, `syncScroll` (split only), `filetype`, `syntaxStyle`, `treeSitterClient`, `wrapMode`, `showLineNumbers`, `conceal`.
- Colors for added, removed and context lines: backgrounds, content backgrounds, signs, and line numbers.
- API: `setLineColor`, `highlightLines`, `getHunkRowOffsets()` (for hunk navigation).
- **No intra-line or word diff** is exposed in the typings or docs. Emulate it with `onHighlight` on a Code, or with LineNumber plus highlights.

### LineNumber (`LineNumberRenderable.d.ts`)

- Wraps a Code or Textarea child to add a gutter.
- Props: `lineColors`, `lineSigns {before, after, colors}`, `lineNumberOffset`, `hideLineNumbers`, a custom `lineNumbers` map, `highlightLines`.
- Use it for diagnostics or diff markers.

### TextTable (`TextTable.d.ts`)

- Cells are `TextChunk[]`.
- Props: `columnWidthMode content|full`, `columnFitter proportional|balanced`, `wrapMode`, padding, borders, `selectable`.

### Image (`Image.d.ts`, `image.d.ts`)

- `<image source={path|URL|bytes|NativeImage} fit="fit|cover|fill" protocol="auto|kitty|sixel|blocks">`.
- It auto-selects the protocol from capabilities and falls back to half-block cells.
- `NativeImage` supports decode, resize, crop, composite and rotate for PNG, JPEG, WebP and GIF.

### EmbeddedTerminal (`EmbeddedTerminal.d.ts`)

- An in-app VT emulator (cols, rows, maxScrollback, `write()`, `screen()`, `encodeKey`, `encodePaste`, selectable).
- Candidate for showing live bash-tool output with correct ANSI.

### Other renderables

- **ASCIIFont** fonts: tiny, block, shade, slick, huge, grid, pallet.
- **Slider**, **ScrollBar**.
- **FrameBuffer**: raw cell drawing (`buffer.drawText`, `setCell`, alpha).
- **TimeToFirstDraw**.
- **VNode composition** (`composition/constructs.d.ts`) for the imperative API.
- **Plugin slots**: `createReactSlotRegistry` and `Slot` in React, core `SlotRenderable`, with `append | replace | single_winner` modes.

## 3. Cross-cutting features

### Layout (Yoga flexbox) and positioning

- Yoga props (`LayoutOptions` in `Renderable.d.ts`): `flexDirection`, `flexGrow`, `flexShrink`, `flexBasis`, `flexWrap`, `alignItems`, `alignSelf`, `justifyContent`, `gap`, `margin*`/`padding*` (X/Y shorthands), `min/max width/height`, `%` and `auto` values, `position: relative|absolute` with top/left/right/bottom, and `overflow: visible|hidden|scroll`.
- Also available: `zIndex`, `opacity` (nested, via push/pop opacity), `visible`, `translateX/Y`, and `buffered` (render to an offscreen framebuffer).
- **Overlays and modals:** use `position="absolute"` with a high `zIndex`. React `createPortal` is exported.
- Gotcha: absolute positioning resolves against the immediate parent, not the nearest positioned ancestor (#1512). Put modals directly under the root box.

### Colors

- `RGBA.fromHex`, `fromInts`, `fromValues`, `fromIndex(n)` (palette index), `defaultForeground/Background()` (the terminal's defaults).
- `ColorInput` accepts hex or CSS names.
- Truecolor is used when `rgb` is supported, with ansi256 detection.

### Themes

- There is **no theming system**. Build your own tokens object.
- The ingredients: `renderer.themeMode` plus the `theme_mode` event (dark/light, live when the terminal supports color-scheme updates), `getPalette()` to adapt to the user's terminal colors, and `SyntaxStyle.fromTheme`.

### Focus

- There is one focused renderable. `focused` in React, or `focus()`/`blur()`.
- Input, Textarea, Select, TabSelect and ScrollBox are focusable. Box needs `focusable`.
- `autoFocus` on click. Events: `focused_renderable` and `focused_editor`.
- There is **no automatic tab order**, so manage focus in app state or with the keymap.

### Keyboard

- `KeyEvent` fields: `{name, ctrl, meta, shift, option, super, hyper, sequence, raw, eventType: press|repeat|release, repeated, source: raw|kitty, code, baseCode, capsLock, numLock}` with `preventDefault()` and `stopPropagation()`.
- Order: global `renderer.keyInput` listeners, then the focused component. `preventDefault` blocks only the focused component; `stopPropagation` blocks everything after it.
- With Kitty keyboard (on by default when the terminal supports it) you get shift+enter vs enter, a reliable Esc, ctrl+c as an event, and release events with `events: true`.
- `@opentui/keymap` provides layered, focus-scoped bindings, multi-key sequences, leader keys, a command catalog with search (good for a command palette and a help sheet), and React hooks `useBindings`, `useActiveKeys`, `usePendingSequence`. Its `addons/opentui` include pre-wired textarea commands.

### Mouse

- Events: `down, up, move, drag, drag-end, drop, over, out, scroll`, via `onMouse*` props. **There is no synthesized click**, so use `onMouseDown`.
- Events bubble with `stopPropagation`. Drag capture is automatic for the left button.
- Hit testing respects zIndex and overflow clipping.
- `setMousePointer("pointer")` sets OSC 22 pointer shapes.
- Use `useMouse: false` to leave selection to the native terminal (a trade-off).

### Selection and copy

- Text-buffer renderables are selectable. One click selects by cell, a double click by word, a triple click by line. Selection works across renderables and auto-scrolls in a scrollbox.
- API: `renderer.getSelection().getSelectedText()`, the `selection` event, and `useSelectionHandler`.
- Copying is **not automatic**. Call `renderer.copyToClipboardOSC52(text)`, or use the clipboard service: `createClipboard({host: createHostClipboard(), terminal: createRendererClipboardAdapter(renderer)})` with destinations `terminal-only | host-only | best-available | all-available`. The service reads MIME types, including **image/png from the host clipboard**, which enables image paste.

### Paste

- Bracketed paste arrives as `PasteEvent {bytes, metadata{mimeType, kind}}`.
- Decode with `decodePasteBytes`. Use `usePaste` or `onPaste`; Textarea handles paste itself.
- To collapse a large paste into a placeholder, `preventDefault` and insert an extmark.

### Resize, animation, links, testing

- Resize: `useTerminalDimensions()` and `useOnResize`.
- Animation: `Timeline` (`animation/Timeline.d.ts`) with easing functions, loop, alternate, and sync. React: `useTimeline()`.
- Links: `detectLinks` plus OSC 8 hyperlinks, and `renderer.getLinkAt`.
- Testing: `@opentui/core/testing` (test renderer, mock keys and mouse, `CapturedFrame`) and `@opentui/react/test-utils`.

## 4. React bindings (`NM/react/src`)

- Entry points: `createRoot(renderer).render(<App/>)`, `unmount()`, `flushSync`, `createPortal`, `ErrorBoundary`, `AppContext`.
- **Hooks:** `useRenderer`, `useKeyboard(handler, {release})`, `usePaste`, `useFocus`/`useBlur` (terminal _window_ focus), `useSelectionHandler`, `useOnResize`, `useTerminalDimensions`, `useTimeline`.
- Props go directly on elements or in `style={{}}`. Props that are not style props (id, content, on*) are excluded from `style`.
- Use `ref` for imperative handles (`ScrollBoxRenderable`, `TextareaRenderable`).
- Custom components: `extend({name: RenderableClass})` plus `declare module "@opentui/react" { interface OpenTUIComponents {...} }`. See the ButtonRenderable example in `NM/react/README.md`.
- React DevTools: set `DEV=true` with `react-devtools-core@7`.
- Plugin slots: `createReactSlotRegistry`, `createSlot`, `Slot`.

## 5. Performance and known limitations

**Strengths:**

- Native Zig diffing: only changed cells are emitted, with synchronized output.
- Text lives in native buffers.
- Rendering is demand-driven.
- ScrollBox viewport culling uses a binary search over sorted children (`lib/objects-in-viewport.d.ts`).
- Markdown parses incrementally and reuses stable blocks.
- Tree-sitter runs in a worker.
- `useThread` is available.

**Costs and caveats (open issues on anomalyco/opentui):**

- **#1339**: every render request walks the whole renderable tree (layout and visibility queries). In OpenCode, one spinner costs about 23% of a core while idle. Consequences:
  - Keep spinners and clocks at a low frequency.
  - Freeze finished transcript blocks: memoise them and don't rerender them.
  - Consider the split-footer scrollback model so finished messages leave the tree entirely.
- **#1493**: native RSS grows about 3 MB/s with 1000 keyed `<text>` in a `<scrollbox>` updated at 10 Hz. Avoid rewriting many texts each tick.
- **#1514**: stickyScroll pulls a reader who has scrolled up back to the tail when layout _shrinks_ (for example when a tool block collapses). Still present in 0.5.11/0.5.12.
- **#1526**: the scrollbar thumb is too short on first render.
- **#1311**: box borders bleed outside the scrollbox clip when partially scrolled.
- **#1494**: Markdown fenced code renders blank without a highlighter or tree-sitter client, so always provide a `treeSitterClient` or a parser for the fence language.
- **#1369**: Markdown backslash escapes render literally.
- **#1289** and **#1296**: CJK wide-grapheme cursor and textarea issues.
- **#1497**: reports of mouse selection stopping.
- **#1512**: the absolute-positioning containing block, covered in §3 under Layout.
- Diff shows only the first patch and has no word diff.
- Select has no filter or custom rows.
- There is no autocomplete widget and no theme system.
- Extmarks are marked experimental.
- In the browser, OpenTUI replaces the global `requestAnimationFrame`; airtty already works around this.

For thousands of lines, prefer these patterns:

- One Markdown renderable per message, not one per line.
- Stream only the last message and set `streaming=false` on completion.
- Keep `viewportCulling` on.
- Collapse old tool output.
- Or commit finished turns to the terminal's scrollback with `split-footer` plus `createScrollbackSurface`. This is how the upstream `split-footer-streaming-demo.ts` streams markdown and code.

## 6. Recommendations: mapping components to agent-TUI parts

| Agent UI part                                     | OpenTUI building block                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Overall mode**                                  | Two options. **(a)** Alternate-screen full app: a root column of `<scrollbox stickyScroll stickyStart="bottom">` transcript + prompt + status line. Simplest, with mouse selection in-app; this is what `examples/agent/components/Transcript.tsx` does now. **(b)** Claude Code/Codex-like inline mode: `screenMode:"split-footer"` with the prompt, status and live streaming block in the footer, and finished turns committed through `writeToScrollback` / `createScrollbackSurface`. Native terminal scrollback and search work and the render tree stays tiny, but finished content is immutable (no collapsing after commit). |
| **Assistant message**                             | `<markdown content={text} streaming={!done} syntaxStyle={theme.syntax} treeSitterClient={client} conceal />`. Use `renderNode` or `createMarkdownCodeBlockRenderer` for `diff` fences, mermaid, and similar. Register extra grammars (python, bash, json, rust, go, and so on) with `addDefaultParsers`.                                                                                                                                                                                                                                                                                                                              |
| **Thinking block**                                | A collapsible `<box>` header (`onMouseDown` toggles) with dim `<text>` or `<markdown fg=muted>`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| **Tool-call blocks**                              | `<box border={["left"]} borderStyle="heavy" borderColor={statusColor}>` or `title=`/`bottomTitle=` for the tool name and duration. Header row with ▸/▾, collapsed by default, tail-N lines while running. Use `<code filetype>` for file reads or writes. For bash output, `<text>` with stripped ANSI, or `EmbeddedTerminal` for true ANSI rendering. Keep `stickyScroll` in mind (#1514) when collapsing.                                                                                                                                                                                                                           |
| **Diffs / edits**                                 | `<diff diff={unifiedPatchPerFile} filetype view={width>140?"split":"unified"} showLineNumbers />`. Split multi-file patches first. Use `getHunkRowOffsets()` for n/p hunk navigation.                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| **Prompt editor**                                 | `<textarea>` with `keyBindings` (enter → submit, shift+enter or ctrl+j → newline, which works reliably with Kitty), `placeholder`, `wrapMode="word"`, height growing up to N lines from `virtualLineCount`, and `onContentChange` / `onCursorChange`. Undo/redo is built in. Use `extmarks` for @file chips and paste placeholders. Handle `onPaste` for large pastes and image paste via the clipboard `read({preferredTypes:["image/png","text/plain"]})`.                                                                                                                                                                          |
| **Completion popup (/commands, @files)**          | Detect the trigger token from `plainText` and `cursorOffset`. Render an absolutely positioned `<box zIndex={100} border>` above the prompt, placed from the textarea's `screenY`/`visualCursor`. Use a custom list (map of `<text>` rows with fuzzy-match highlighting spans) rather than `<select>`, which cannot filter or render custom rows. Intercept up, down, tab, enter and esc with a global `useKeyboard` + `preventDefault` so the textarea doesn't consume them, or use keymap layers active only while the popup is open. Set `traits` accordingly.                                                                      |
| **Approval dialog**                               | A full-screen absolute `<box zIndex>` backdrop (semi-transparent with `opacity` or a dim bg) plus a centered bordered box with `title="Allow Bash?"`. Show the command in `<code>` or `<diff>`, then `<select>` or button rows (y/n/a), with focus moved to it.                                                                                                                                                                                                                                                                                                                                                                       |
| **Model picker / command palette / session list** | A modal containing an `<input>` filter plus a filtered list (`<select options>` re-set on each keystroke works for a flat list, or custom rows). Get the command inventory from `@opentui/keymap`'s command catalog (search, `formatKey` for shortcut hints).                                                                                                                                                                                                                                                                                                                                                                         |
| **Status line**                                   | A one-row `<box flexDirection="row" justifyContent="space-between">` with `<text>` spans (model, cwd/branch, tokens/context %, cost, mode). A spinner through `useTimeline` or an interval at 80-120 ms, only while busy (#1339).                                                                                                                                                                                                                                                                                                                                                                                                     |
| **Todo panel**                                    | A side or top `<box border title="Todos">` with `<text>` rows: ☐/☑ glyphs, strikethrough attribute for done, a color for in-progress. Toggle with a key.                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| **Scrolling**                                     | Scroll a ref'd `ScrollBoxRenderable` with `scrollBy(±0.5, "viewport")` on PgUp/PgDn, `scrollTo(scrollHeight)` for "jump to bottom", and `scrollChildIntoView(blockId)` for j/k block navigation.                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| **Copy**                                          | On the `selection` event, or a y key: `copyToClipboardOSC52(sel.getSelectedText())` or the clipboard service `best-available`. Show a toast.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| **Notifications**                                 | `renderer.triggerNotification("Claude needs approval")` when the terminal window is blurred (`useBlur`). Use `setTerminalTitle` for status.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| **Theming**                                       | A tokens object from `themeMode` (dark/light), optionally adapted from `getPalette()`. `SyntaxStyle.fromTheme` for code and markdown.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| **Images**                                        | `<image source protocol="auto">` for image attachments and screenshots (Kitty and sixel, with a block fallback).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| **Debug**                                         | Console overlay (`renderer.console.toggle()`), `toggleDebugOverlay()` for FPS and stats, and React DevTools.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |

## Sources

- Installed typings: `NM/core/{renderer,types,Renderable,console,syntax-style,image,edit-buffer,editor-view}.d.ts`, `NM/core/renderables/*.d.ts`, `NM/core/lib/{KeyHandler,parse.keypress,parse.mouse,paste,clipboard,selection,styled-text,extmarks,terminal-palette,scroll-acceleration,tree-sitter/*}.d.ts`, `NM/core/assets/*`, `NM/core/README.md`, `NM/react/README.md`, `NM/react/src/**/*.d.ts`, `NM/keymap/README.md`.
- Docs: https://opentui.com/docs, https://opentui.com/docs/core-concepts/renderer, …/interaction, …/keyboard, …/clipboard, https://opentui.com/docs/components/scrollbox, …/markdown, …/diff, …/textarea.
- Repo: https://github.com/anomalyco/opentui (examples in `packages/examples/src/*`, esp. `split-footer-streaming-demo.ts`, `sticky-scroll-example.ts`, `extmarks-demo.ts`, `clipboard-paste-demo.ts`; React examples in `packages/react/examples/*`). Issues #1339, #1493, #1514, #1526, #1311, #1494, #1369, #1512, #1434, #809, #1289, #1296, #1497.
- Consumer: `/Users/sykar-f/workdir/drafts/airtty/examples/agent/components/Transcript.tsx`, `packages/airtty/src/web/platform/run.tsx`.
