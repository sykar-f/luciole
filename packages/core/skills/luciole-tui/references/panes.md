# Terminals and apps in panes

Read `node_modules/@luciole-sh/core/docs/guides/terminals-and-panes.md` for every prop.
`examples/mux` in the luciole repository is a whole tmux built this way.

- A program in a pane is `<Terminal command={[...]} active prefix />` from
  `@luciole-sh/core/client`: a real PTY with its own emulator. Do not spawn the program with
  `Bun.spawn` and draw its output, and do not add `node-pty` or `xterm`.
- Another luciole app in a pane is `<Embed app name active prefix />`, with `app` from
  `openApplication({ bundle, url })`. Call `app.dispose()` when the pane closes.
- `active` gives the pane every key, Ctrl+C included. Exactly one pane is active; the host
  keeps which one in state.
- `prefix="ctrl+o"` keeps Ctrl+O and the sequences it starts for the app's bindings. The
  prefix does nothing alone: bind its sequences, written glued (`"ctrl+oo"` is Ctrl+O then O).
  Without a prefix, only a click or a change of `active` gives the keys back.
- `<Terminal>` takes no border or title: wrap it in a `<box border borderColor title>` and
  colour the border from the active pane. `onMouseDown` on that box moves the keys there.
- `command` changing restarts the program; unmounting hangs it up. `onExit(code)` reports its
  end (`code` is `null` when it was killed or not found).
- The component holding the panes is a Client Component: a page renders it, and it starts
  with `"use client"`. Reading `process.env.SHELL` there reads the user's machine.

```tsx
"use client";
import { useState } from "react";
import { KeyHelp, Terminal, useBindings } from "@luciole-sh/core/client";

const PREFIX = "ctrl+o";
const PANES = [[process.env.SHELL || "/bin/sh"], ["top"]];

export function Panes() {
  const [active, setActive] = useState(0);
  useBindings(
    () => ({
      bindings: [
        {
          key: `${PREFIX}o`,
          cmd: () => setActive((a) => (a + 1) % PANES.length),
          desc: "next pane",
          group: "panes",
        },
      ],
    }),
    [],
  );
  return (
    <box flexDirection="column" flexGrow={1}>
      <box flexDirection="row" flexGrow={1}>
        {PANES.map((command, i) => (
          <box
            key={command.join(" ")}
            flexGrow={1}
            flexBasis={0}
            border
            borderColor={i === active ? "#67d9bc" : "#526d82"}
            title={` ${command.join(" ")} `}
            onMouseDown={() => setActive(i)}
          >
            <Terminal command={command} active={i === active} prefix={PREFIX} flexGrow={1} />
          </box>
        ))}
      </box>
      <box height={1} flexShrink={0}>
        <KeyHelp inline groups={["panes"]} />
      </box>
    </box>
  );
}
```
