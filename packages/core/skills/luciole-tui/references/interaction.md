# Rich interaction in small screens

## Contents

- [Clickable row and hover](#clickable-row-and-hover)
- [Context menu](#context-menu)
- [Loading animation](#loading-animation)
- [Image with a fallback](#image-with-a-fallback)
- [Other interaction branches](#other-interaction-branches)

Check the installed `@opentui/core/Renderable.d.ts`, `renderer.d.ts`, `types.d.ts` and
`renderables/Image.d.ts`; React hooks are in `@opentui/react/src/hooks/index.d.ts`.
The renderer exposes terminal features directly. Reuse those methods.

## Clickable row and hover

Save as `components/ActionRow.tsx`. Use a labelled row for an action, with a colour change
and pointer on hover. A status line or hover hint can explain an ambiguous label.

```tsx
"use client";
import { useEffect, useState } from "react";
import { MouseButton, type MouseEvent } from "@opentui/core";
import { useRenderer } from "@opentui/react";

export function ActionRow({
  label,
  run,
  context,
}: {
  label: string;
  run: () => void;
  context?: (event: MouseEvent) => void;
}) {
  const renderer = useRenderer();
  const [hover, setHover] = useState(false);
  useEffect(() => () => renderer.setMousePointer("default"), [renderer]);
  return (
    <box
      height={1}
      flexShrink={0}
      backgroundColor={hover ? "#334155" : "#0f172a"}
      onMouseOver={() => {
        setHover(true);
        renderer.setMousePointer("pointer");
      }}
      onMouseOut={() => {
        setHover(false);
        renderer.setMousePointer("default");
      }}
      onMouseDown={(event) => {
        if (event.button === MouseButton.RIGHT && context) {
          event.preventDefault();
          event.stopPropagation();
          context(event);
        } else if (event.button === MouseButton.LEFT) {
          event.stopPropagation();
          run();
        }
      }}
    >
      <text height={1} wrapMode="none" truncate fg="#f8fafc">
        {label}
      </text>
    </box>
  );
}
```

## Context menu

Save as `components/DocumentActions.tsx`, alongside `ActionRow`. Mount this example at the
terminal origin, filling the screen: mouse `x`/`y` are terminal cells. In a nested pane,
subtract the pane's rendered `x`/`y` before positioning its overlay. The visible **More…**
entry also opens the menu; right-click is a shortcut to it. Items and bindings share actions.
The full-screen backdrop closes on an outside click; menu events stop before reaching it.
Esc belongs to the mounted menu layer. Clamp again on resize, including very small screens.

```tsx
"use client";
import { useState } from "react";
import { type MouseEvent } from "@opentui/core";
import { useRenderer, useTerminalDimensions } from "@opentui/react";
import { useBindings } from "@luciole-sh/core/client";
import { ActionRow } from "./ActionRow";

type Point = { x: number; y: number };
function Menu({
  at,
  close,
  open,
  copy,
}: {
  at: Point;
  close: () => void;
  open: () => void;
  copy: () => void;
}) {
  const { width, height } = useTerminalDimensions();
  const menuWidth = Math.min(24, width);
  const menuHeight = Math.min(2, height);
  useBindings(
    () => ({ bindings: [{ key: "escape", cmd: close, desc: "Close menu", group: "menu" }] }),
    [close],
  );
  const choose = (action: () => void) => {
    close();
    action();
  };
  return (
    <box
      position="absolute"
      top={0}
      left={0}
      width="100%"
      height="100%"
      zIndex={100}
      onMouseDown={close}
    >
      <box
        position="absolute"
        left={Math.max(0, Math.min(at.x, width - menuWidth))}
        top={Math.max(0, Math.min(at.y, height - menuHeight))}
        width={menuWidth}
        height={menuHeight}
        overflow="hidden"
        zIndex={101}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <scrollbox width="100%" height="100%">
          <ActionRow label="Open          Ctrl+O" run={() => choose(open)} />
          <ActionRow label="Copy path     Ctrl+Y" run={() => choose(copy)} />
        </scrollbox>
      </box>
    </box>
  );
}

export function DocumentActions({ path, onOpen }: { path: string; onOpen: () => void }) {
  const renderer = useRenderer();
  const [at, setAt] = useState<Point | null>(null);
  const [result, setResult] = useState("");
  const open = () => {
    onOpen();
    setResult("Opened");
  };
  const copy = () =>
    setResult(renderer.copyToClipboardOSC52(path) ? "Copied path" : "Copy unavailable");
  const show = (event: MouseEvent) => setAt({ x: event.x, y: event.y });
  useBindings(
    () => ({
      bindings: [
        { key: "ctrl+o", cmd: open, desc: "Open", group: "document" },
        { key: "ctrl+y", cmd: copy, desc: "Copy path", group: "document" },
      ],
    }),
    [onOpen, renderer, path],
  );
  return (
    <box width="100%" height="100%" flexDirection="column">
      <ActionRow label={`Open ${path}`} run={open} context={show} />
      <ActionRow label="More…" run={() => setAt({ x: 0, y: 2 })} context={show} />
      <text height={1} wrapMode="none" truncate>
        {result}
      </text>
      {at ? <Menu at={at} close={() => setAt(null)} open={open} copy={copy} /> : null}
    </box>
  );
}
```

For a longer menu use `<scrollbox>` (wheel support) and focusable `<select>` or bindings
for Up/Down/Return; preserve the same click actions and display their shortcut labels.

## Loading animation

Save as `components/Pulse.tsx`. This is the fixed-geometry opacity pulse from the installed
starter's Pulse component (also `examples/chat/components/Pulse.tsx` in the repository).
Use it around a compact loading label or a skeleton matching the arriving page. For a
spinner, change only a glyph within a fixed-width cell. Pause the timeline on unmount.

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
