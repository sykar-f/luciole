---
name: luciole-tui
description: Terminal UI in a luciole app. Use when laying out or styling a screen, a pane, a sidebar, a footer or a status bar; when adding a keyboard shortcut, a key binding, a help line or a list of shortcuts; when moving focus between fields or panes; when reacting to the terminal's size or a resize; when showing the connection state; when running a shell, vim or another program inside the app (a terminal pane, a split, a small tmux) or embedding another luciole app; when highlighting code or drawing math. Phrasings such as "add a shortcut", "show the keys", "split the screen", "add a status bar", "two panes side by side", "open a shell in the app".
---

# luciole terminal UI

The screen is OpenTUI, rendered by React 19: intrinsics from `@opentui/react` (`<box>`,
`<text>`, `<span>`, `<scrollbox>`, `<input>`, `<textarea>`, `<select>`, `<code>`,
`<markdown>`). There is no DOM, no CSS and no `window`. Routes, pages and data belong to the
`luciole-app` skill.

Before writing a screen, read one of the app's own components (the starter's
`app/layout.tsx`, `components/StatusLine.tsx`) and copy its idioms. API:
`node_modules/@luciole-sh/core/docs/reference/api.md`, section "Restore fields and bind keys".

## Layout

- A `<box>` is a flex container (`flexDirection="row"` or `"column"`). Size with `flexGrow`,
  `flexShrink`, `flexBasis`, `width`, `height` (cells, or `"50%"`), space with `padding`,
  `paddingX`, `margin`, `gap`. Panes side by side: `flexDirection="row"`, each child
  `flexGrow={1} flexBasis={0}`.
- A one-line bar (footer, status bar): `<box height={1} flexShrink={0}>`, and the content
  above it `flexGrow={1}`. Without `flexShrink={0}` the bar is squeezed to nothing.
- Frames: `border`, `borderColor`, `title` on the `<box>`. Overlays: `position="absolute"`
  with `top`/`left`/`zIndex`.
- Colors are props: `fg`, `bg` on `<text>` and `<span>`, `backgroundColor` on `<box>`, as
  hex strings.
- The terminal's size: `const { width, height } = useTerminalDimensions()` from
  `@opentui/react`. It re-renders on every resize. Never read `process.stdout.columns`.

## Keys

The framework binds only Ctrl+C (quit) and Esc (cancel a pending navigation), in the group
`luciole`. Every other key is the app's. Bind with `useBindings` from
`@luciole-sh/core/client`, not with `useKeyboard`:

```tsx
useBindings(
  () => ({
    bindings: [
      { key: "ctrl+r", cmd: () => void refresh(), desc: "refresh", group: "global" },
      { key: "ctrl+t", cmd: () => setDebug((shown) => !shown), desc: "requests", group: "global" },
    ],
  }),
  [refresh],
);
```

- A help line or footer that lists the shortcuts is `<KeyHelp inline groups={[...]} />` from
  `@luciole-sh/core/client`, fed by the bindings' `desc` and `group`. It follows the bindings
  that are mounted now; never write the shortcuts out by hand. Put `"luciole"` in `groups` to
  list Ctrl+C. Give `desc` and `group` to existing bindings you want listed.
- A layer lives with its component: the page's keys and their help leave with the page.
- The second argument is the dependency list, as for `useEffect`: list what `cmd` reads.
- A sequence is written glued: `"ctrl+oo"` is Ctrl+O, then O.

## Focus

Focus is a prop, not a DOM call: `<input focused={field === "title"} />`. Keep which field
has it in state (`useRestoredFocus(names)` keeps it per history entry). Tab between fields is
a binding: `{ key: "tab", cmd: () => cycle(1) }`.

## Status UI

The framework draws no status bar. `useConnection()` returns
`{ status, error, buildError, activity, refresh }`; `status` is already the words to show
(`Connected`, `Disconnected`, …).

## Terminals and apps in panes

Read [references/panes.md](references/panes.md) when a pane runs a shell, vim or any program,
or shows another luciole app.

## Code and math

`import "@luciole-sh/core/grammars"` once, in a Client module, colours Bash, Python, Go…
in `<code>` and `<markdown>`. Display math is `renderMath` from `@luciole-sh/core/math`. Both
need packages the starter already lists; for another app, see
`node_modules/@luciole-sh/core/docs/reference/optional-packages.md`.

## Gotchas

- A module with hooks or keys starts with `"use client"`, before any import. Layouts are
  always Client Components.
- Text lives inside `<text>`: a string, a number or a `<span>` directly in a `<box>` throws
  "Text must be created inside of a text node". Write `{n > 0 ? <text>…</text> : null}`,
  not `{n && …}`.
- Inside `<text>`, style a part with `<span fg=…>`, `<strong>`, `<em>`, `<u>`; give a bar's
  `<text>` `height={1} wrapMode="none" truncate`.
- A binding sees the key before the focused `<input>`: a plain key (`j`, `/`, `return`)
  bound while a field has the focus eats the typing. Make such bindings depend on the focus
  state, and use `ctrl+…` for window-wide shortcuts.
