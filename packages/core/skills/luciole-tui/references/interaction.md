# Rich interaction in small screens

## Contents

- [Reuse the app's interactions](#reuse-the-apps-interactions)
- [Item row with the starter's menu](#item-row-with-the-starters-menu)
- [Apps without these primitives](#apps-without-these-primitives)
- [Loading animation](#loading-animation)
- [Image with a fallback](#image-with-a-fallback)
- [Other interaction branches](#other-interaction-branches)

## Reuse the app's interactions

Inspect the app before writing interaction code. In the starter, `components/ui.tsx` supplies
`useHover` (state and pointer), `Button`/`IconButton` (button hover), `MenuLayer` and `ToastLayer`;
`components/ui-state.ts` supplies `ui.openMenu({ items, x, y })`, `ui.closeMenu()` and `ui.toast`.
Read `components/Sidebar.tsx` for the item-row model: row hover, click to open, right-click
and a "⋯" entrance revealed on hover or selection. These are app components, not luciole exports;
a diverged app may use different files or signatures. Reuse its equivalents.

A button's hover feedback covers the button. The item row itself also needs hover and click.
Keep secondary actions in the item's menu, with destructive items marked and results reported.
A screen-level primary action can be a plain button. Mount existing menu/toast layers once at
screen scope (check `app/layout.tsx`); opening state alone paints nothing without the layer.

## Item row with the starter's menu

After checking those local signatures, this compact adaptation of the Sidebar row can live in
`components/ItemRow.tsx`. Both entrances use the same item's callbacks. The "⋯" handler stops
propagation so opening the menu does not also open the item. Existing `MenuLayer` handles
Escape, outside click, placement and closing before running an action. Mount it and
`ToastLayer` at screen scope if the layout does not already do so.

```tsx
"use client";
import { useEffect } from "react";
import { MouseButton } from "@opentui/core";
import { useRenderer } from "@opentui/react";
import { useHover } from "./ui";
import { ui } from "./ui-state";
import { usePalette } from "./theme";

export function ItemRow({
  label,
  selected = false,
  open,
  duplicate,
  remove,
}: {
  label: string;
  selected?: boolean;
  open: () => void;
  duplicate: () => void;
  remove: () => void;
}) {
  const color = usePalette();
  const renderer = useRenderer();
  const { hovered, handlers } = useHover();
  useEffect(() => () => renderer.setMousePointer("default"), [renderer]);
  const menu = (x: number, y: number) =>
    ui.openMenu({
      x,
      y,
      items: [
        { label: "Open", run: open },
        {
          label: "Duplicate",
          run: () => {
            duplicate();
            ui.toast({ text: "Duplicated" });
          },
        },
        {
          label: "Delete",
          danger: true,
          run: () => {
            remove();
            ui.toast({ text: "Deleted" });
          },
        },
      ],
    });
  return (
    <box
      flexDirection="row"
      height={1}
      flexShrink={0}
      backgroundColor={selected ? color.selected : hovered ? color.hover : undefined}
      {...handlers}
      onMouseDown={(event) => {
        if (event.button === MouseButton.RIGHT) menu(event.x, event.y);
        else if (event.button === MouseButton.LEFT) open();
      }}
    >
      <text flexGrow={1} height={1} wrapMode="none" truncate fg={color.text}>
        {label}
      </text>
      {hovered || selected ? (
        <box
          flexShrink={0}
          paddingX={1}
          onMouseDown={(event) => {
            event.stopPropagation();
            menu(event.x, event.y + 1);
          }}
        >
          <text fg={color.muted}>⋯</text>
        </box>
      ) : null}
    </box>
  );
}
```

## Apps without these primitives

Only build a primitive when the app lacks an equivalent. Verify props and methods in installed
`@opentui/core/Renderable.d.ts`, `renderer.d.ts`, `types.d.ts`; hooks are in
`@opentui/react/src/hooks/index.d.ts`. A row uses `onMouseOver`/`onMouseOut` for colour and
`setMousePointer("pointer")`/`"default"`, restoring on unmount. Check `MouseButton.RIGHT` and
`MouseButton.LEFT` from `@opentui/core`.

A menu shares one action list between right-click and a visible entrance. Mouse `x`/`y` are
terminal cells: mount its overlay at terminal origin or subtract the containing pane's
rendered coordinates. Clamp on resize; use a full-screen backdrop for outside dismissal,
stop menu-event propagation, and bind Esc through `useBindings` while mounted. Longer menus
use `<scrollbox>` and focusable `<select>` or Up/Down/Return bindings. Preserve click actions
and shortcut labels. Report the chosen action's result in a toast or status.

## Loading animation

Reuse `components/Pulse.tsx` if present. The fallback below uses the starter's fixed-geometry
opacity pulse (also `examples/chat/components/Pulse.tsx` in the repository). Mount the animated
label only while pending; reserve its space so content stays in place. Disabled content may
dim. Show the result when pending ends. For a spinner, change only a glyph in a fixed-width
cell. Pause the timeline on unmount.

```tsx
"use client";
import { useEffect, useRef, type ReactNode } from "react";
import { useTimeline } from "@opentui/react";
import type { BoxRenderable } from "@opentui/core";

export function Pulse({ children }: { children: ReactNode }) {
  const target = useRef<BoxRenderable>(null);
  const timeline = useTimeline({ autoplay: false, duration: 1700, loop: true });
  useEffect(() => {
    if (!target.current) return;
    timeline.add(target.current, {
      duration: 850,
      ease: "inOutSine",
      opacity: 0.25,
      loop: true,
      alternate: true,
    });
    timeline.play();
    return () => {
      timeline.pause();
    };
  }, [timeline]);
  return (
    <box ref={target} flexDirection="column" flexGrow={1}>
      {children}
    </box>
  );
}
```

## Image with a fallback

Save as `components/Thumbnail.tsx`. Paths belong to the Client machine; a Server file path
is usable only if the Client also has it. `auto` negotiates Kitty/Sixel and falls back to
blocks; unsupported image protocols do not excuse a missing label. Keep a bounded image
area and a readable error fallback. Remount by source so a new image can recover from an error.

```tsx
"use client";
import { useState } from "react";

function Picture({ source, label }: { source: string; label: string }) {
  const [failed, setFailed] = useState(false);
  return (
    <box width={16} height={6} flexShrink={0} flexDirection="column">
      {failed ? (
        <text>{label}: image unavailable</text>
      ) : (
        <image
          source={source}
          protocol="auto"
          fit="fit"
          height={5}
          onError={() => setFailed(true)}
        />
      )}
      <text height={1} wrapMode="none" truncate>
        {label}
      </text>
    </box>
  );
}
export function Thumbnail(props: { source: string; label: string }) {
  return <Picture key={props.source} {...props} />;
}
```

## Other interaction branches

- Resize handles: `onMouseDrag` updates a bounded split width from `event.x`,
  `onMouseDragEnd` finishes it; show `col-resize` on hover and restore `default` on exit.
  Use `onMouseDrop` for drop targets. Keep a visible handle and a keyboard resize action.
- Lists and content: let `<scrollbox>` handle wheel input; custom handlers use
  `onMouseScroll` and `event.scroll`. Use `event.modifiers` for modified gestures.
- URLs: `<text><a href="https://luciole.sh">luciole docs</a></text>` is a terminal hyperlink;
  terminal support determines activation. Use luciole navigation for app routes.
- Document identity: `useRenderer().setTerminalTitle(title)` in an effect; restore the
  app's title on cleanup. `renderer.themeMode` is `"dark"`, `"light"` or `null`; choose a
  readable default for unknown mode. Inspect `renderer.capabilities` for optional features.
- Keep permanent chrome small: one primary action, current state, the current layer's few
  keys. Move details to an overlay; below a `useTerminalDimensions()` width threshold,
  fold the sidebar and shorten labels. A wait or empty state includes the relevant action.
