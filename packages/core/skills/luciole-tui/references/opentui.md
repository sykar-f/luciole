# Choose an installed OpenTUI widget

Before composing controls, read
`node_modules/@luciole-sh/core/docs/reference/upstream-libraries.md` for luciole's boundaries.
Start with `node_modules/@opentui/react/README.md` and `node_modules/@opentui/core/README.md`.
Check each package's `package.json` exports, then its root declaration (`@opentui/react/src/index.d.ts`
or `@opentui/core/index.d.ts`): a symbol mentioned in another declaration may be internal.

## Match the task to a component

The declaration column is relative to `node_modules/@opentui/core/renderables/`.
Check JSX names in `node_modules/@opentui/react/jsx-namespace.d.ts` and callbacks/refs in
`node_modules/@opentui/react/src/types/components.d.ts` before using a row.

| Task                                              | Inspect                                                                           | Declaration                     |
| ------------------------------------------------- | --------------------------------------------------------------------------------- | ------------------------------- |
| Frame, flex layout, panes                         | `<box>`                                                                           | `Box.d.ts`                      |
| Styled text, external terminal hyperlink          | `<text>`, `<span>`, `<a href>`                                                    | `Text.d.ts`, `TextNode.d.ts`    |
| Scrolling content                                 | `<scrollbox>`; named luciole `ScrollBox` for restoration                          | `ScrollBox.d.ts`                |
| One-line or multiline editing                     | `<input>`, `<textarea>`; named luciole `Input`, `Textarea` for drafts             | `Input.d.ts`, `Textarea.d.ts`   |
| Vertical choice list                              | `<select>`                                                                        | `Select.d.ts`                   |
| Horizontal choices, view modes                    | `<tab-select>`                                                                    | `TabSelect.d.ts`                |
| Patch with colors, gutters, unified or split view | `<diff>` with `diff` and `view`                                                   | `Diff.d.ts`                     |
| Code or Markdown                                  | `<code>`, `<markdown>`; luciole `Markdown` for stable streaming, links and images | `Code.d.ts`, `Markdown.d.ts`    |
| Code gutter, diagnostics                          | `<line-number>`                                                                   | `LineNumberRenderable.d.ts`     |
| Large ASCII title                                 | `<ascii-font>`                                                                    | `ASCIIFont.d.ts`                |
| Raster image                                      | `<image>`                                                                         | `Image.d.ts`                    |
| Table or slider                                   | `TextTableRenderable`, `SliderRenderable` through `extend`                        | `TextTable.d.ts`, `Slider.d.ts` |

Survey `node_modules/@opentui/core/renderables/index.d.ts` for other candidates. For classes
without a JSX tag, follow the React README's component extension recipe and its
`OpenTUIComponents` augmentation. Confirm the class is exported at the package root.
For hooks, follow `node_modules/@opentui/react/src/hooks/index.d.ts` from the root exports:
resize, paste, focus and selection hooks may already cover the event you need.
Installed sources supply the exact API even when an upstream website shows a newer version.

## Adapt the widget to luciole

Use Client Components for native refs, hooks and callbacks within luciole's existing Shell.
Follow the boundary guide for named restoration wrappers and shared keymap hooks.
Raw `<textarea>` callbacks carry a content event; luciole `Textarea` provides controlled
`value` and `onChange(string)`. Images read local paths on the Client machine; use `protocol="auto"` (Kitty/Sixel when
supported, blocks otherwise), and an `onError` fallback. `<a href>` lives inside `<text>`.

Let the focused widget handle its native editing/selection keys. When those keys must
appear in `<KeyHelp>`, bind them through luciole's shared keymap and delegate to the widget.
Read `node_modules/@opentui/keymap/README.md` and `src/react/index.d.ts` for target scoping.
This complete picker delegates wrapping, scrolling and selection to OpenTUI:

```tsx
"use client";
import { useRef } from "react";
import type { TabSelectRenderable } from "@opentui/core";
import { KeyHelp, useBindings } from "@luciole-sh/core/client";

export function ViewPicker({ focused }: { focused: boolean }) {
  const picker = useRef<TabSelectRenderable>(null);
  useBindings(
    () => ({
      targetRef: picker,
      targetMode: "focus",
      bindings: [
        {
          key: "left",
          desc: "Previous view",
          group: "views",
          cmd: () => picker.current?.moveLeft(),
        },
        { key: "right", desc: "Next view", group: "views", cmd: () => picker.current?.moveRight() },
        {
          key: "return",
          desc: "Choose view",
          group: "views",
          cmd: () => picker.current?.selectCurrent(),
        },
      ],
    }),
    [],
  );
  return (
    <box flexDirection="column">
      <tab-select
        ref={picker}
        focused={focused}
        options={[
          { name: "Summary", description: "Overview" },
          { name: "Patch", description: "Changed lines" },
        ]}
      />
      <KeyHelp inline groups={["views"]} />
    </box>
  );
}
```

Connect `onChange(index, option)` or `onSelect(index, option)` to app state, handling a null
option. For route-controlled tabs, synchronize the typed ref with `setSelectedIndex` in
an effect; `<tab-select>` has no `selectedIndex` prop. The setter emits `onChange`, even
for the same index: guard the callback against navigating to the route already active.
The `luciole-app` routing reference shows that synchronization with typed matching.
