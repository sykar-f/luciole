---
name: luciole-tui
description: Screens and rich interaction in a luciole app with OpenTUI. Use for layout, styling, sidebars, status bars, focus, terminal resize, connection state, code or math; shortcuts and key help; running a shell or vim in a pane, splitting panes or embedding an app; clickable items, hover, tooltip, right click or context menu; loading animation or spinner; image display. Phrasings such as "add a shortcut", "open a shell in the app", "two panes side by side", "make it look nice", "easier to use", "discoverable".
---

# luciole terminal UI

The screen is OpenTUI, rendered by React 19. Routes, pages and data belong to `luciole-app`.

Before composing a screen, read [references/opentui.md](references/opentui.md), survey the
installed components and reuse the widget's own behaviour. Then read the app's
`app/layout.tsx` and `components/StatusLine.tsx` for its visual conventions.
API: `node_modules/@luciole-sh/core/docs/reference/api.md`, section "Restore fields and bind keys".

## Design

- Design for a newcomer, like a desktop app: clicks are first-class; actionable items have
  hover feedback and a pointer. Right-click exposes secondary actions; use drag and wheel
  where they fit. Keys accelerate the same actions available through buttons, tabs or menus.
- Make actions self-discoverable: labelled controls, empty states with their filling action,
  hover hints and menu items showing shortcuts. Keep `<KeyHelp>` to the current layer's few keys.
- Make waits alive (`loading.tsx`, pending actions, slow loads): animate opacity or a spinner
  in fixed geometry, stop on unmount, and report the action's result.
- Use images, hyperlinks and clipboard where useful; prefer native Markdown, code and diff
  widgets. Use the current document as terminal title and adapt the palette to the theme.
- Keep one primary task per screen. Show the few frequent actions; disclose the rest in menus,
  overlays or secondary views. Spend no line on decoration, truncate bars, and fold sidebars
  or shorten labels at narrow terminal widths.

Read [references/interaction.md](references/interaction.md) when a screen has clickable items,
menus, hover, images or a wait.

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
`luciole`. Every other key is the app's. Give refresh and debug visible controls calling the same
functions as their bindings. Bind with `useBindings` from
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
- A right-click handler checks `event.button === MouseButton.RIGHT` from `@opentui/core`;
  left-click actions check `MouseButton.LEFT`. Reset hover state on `onMouseOut`, and restore
  the renderer's pointer on exit and unmount.
