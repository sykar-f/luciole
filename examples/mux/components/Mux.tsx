"use client";
import { useEffect, useState, type ReactNode } from "react";
import { z } from "zod";
import { Terminal, useApplication, useBindings, usePendingSequence } from "airtty/client";

type Pane = { id: number; command: readonly string[] };
const PREFIX = "ctrl+o";
const shell = process.env.SHELL || "/bin/sh";
const hasVim = Bun.which("vim") !== null;
// MUX_PANES='[["sh"],["vim","-u","NONE"]]' replaces the first panes (tests, scripts).
const Commands = z.array(z.array(z.string()).min(1)).min(1);
function firstCommands(): (readonly string[])[] {
  const configured = process.env.MUX_PANES;
  if (configured) {
    const parsed: unknown = JSON.parse(configured);
    return Commands.parse(parsed);
  }
  return hasVim ? [[shell], ["vim"]] : [[shell]];
}

/**
 * A small tmux: panes side by side, each a local program on a PTY. Ctrl+O is the only key
 * the host keeps; the sequences it starts (`ctrl+oo`) are ordinary keymap bindings.
 * Everything else, Ctrl+C included, goes to the active pane.
 */
export function Mux({ children }: { children: ReactNode }) {
  const app = useApplication();
  const [{ panes, active }, setMux] = useState(() => {
    const first = firstCommands().map((command, id): Pane => ({ id, command }));
    return { panes: first, active: 0, next: first.length };
  });
  const pending = usePendingSequence();
  const open = (command: readonly string[]) =>
    setMux((m) => ({
      panes: [...m.panes, { id: m.next, command }],
      active: m.next,
      next: m.next + 1,
    }));
  // Closing a pane unmounts its <Terminal>, which hangs its program up; the pane on its
  // left takes the keys.
  const close = (id: number) =>
    setMux((m) => {
      const at = m.panes.findIndex((p) => p.id === id);
      if (at < 0) return m;
      const panes = m.panes.filter((p) => p.id !== id);
      const neighbour = panes[Math.max(0, at - 1)]?.id ?? -1;
      return { ...m, panes, active: m.active === id ? neighbour : m.active };
    });
  const cycle = () =>
    setMux((m) => {
      const at = m.panes.findIndex((p) => p.id === m.active);
      return { ...m, active: m.panes[(at + 1) % m.panes.length]?.id ?? m.active };
    });
  // The last program ended: so does the multiplexer, as tmux does.
  const empty = panes.length === 0;
  useEffect(() => {
    if (empty) app.quit?.();
  }, [app, empty]);
  const focus = (id: number) => setMux((m) => ({ ...m, active: id }));
  useBindings(
    () => ({
      bindings: [
        { key: `${PREFIX}o`, cmd: cycle, desc: "next pane", group: "mux" },
        { key: `${PREFIX}c`, cmd: () => open([shell]), desc: "new shell", group: "mux" },
        ...(hasVim
          ? [{ key: `${PREFIX}v`, cmd: () => open(["vim"]), desc: "vim", group: "mux" }]
          : []),
        { key: `${PREFIX}x`, cmd: () => close(active), desc: "close pane", group: "mux" },
        { key: `${PREFIX}q`, cmd: () => app.quit?.(), desc: "quit", group: "mux" },
      ],
    }),
    [app, active],
  );
  return (
    <box flexDirection="column" flexGrow={1}>
      <box flexDirection="row" flexGrow={1}>
        {panes.map((pane) => (
          <box
            key={pane.id}
            id={`mux-pane-${pane.id}`}
            flexGrow={1}
            flexBasis={0}
            border
            borderColor={pane.id === active ? "#67d9bc" : "#526d82"}
            title={` ${pane.id} · ${pane.command.join(" ")} `}
            onMouseDown={() => focus(pane.id)}
          >
            <Terminal
              command={pane.command}
              active={pane.id === active}
              prefix={PREFIX}
              flexGrow={1}
              onExit={() => close(pane.id)}
            />
          </box>
        ))}
      </box>
      <box flexDirection="row" height={1} flexShrink={0} gap={2}>
        <text id="mux-status" wrapMode="none" fg={pending.length ? "#ffbc66" : "#67d9bc"}>
          {pending.length ? "PREFIX" : `MUX · pane ${active} of ${panes.length}`}
        </text>
        {children}
      </box>
    </box>
  );
}
