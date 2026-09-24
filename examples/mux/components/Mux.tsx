"use client";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { z } from "zod";
import {
  Embed,
  Terminal,
  openApplication,
  useApplication,
  useBindings,
  usePendingSequence,
  type Application,
} from "airtty/client";

/** A local program on a PTY, or another airtty application inline. */
type Spec =
  | { kind: "terminal"; command: readonly string[] }
  | { kind: "app"; name: string; client: string; url: string };
type Pane = Spec & { id: number };
const PREFIX = "ctrl+o";
const shell = process.env.SHELL || "/bin/sh";
const hasVim = Bun.which("vim") !== null;
// MUX_PANES='[["sh"],["vim","-u","NONE"]]' replaces the first terminal panes.
const Commands = z.array(z.array(z.string()).min(1)).min(1);
// MUX_APPS='[{"name":"docs","client":"/…/mdreader/.airtty/client/index.js","url":"http://127.0.0.1:3000"}]'
// adds airtty applications, each with its already running Server.
const Apps = z.array(z.object({ name: z.string(), client: z.string(), url: z.string() }));
const fromEnv = <T,>(name: string, schema: z.ZodType<T>): T | undefined => {
  const configured = process.env[name];
  if (!configured) return undefined;
  const parsed: unknown = JSON.parse(configured);
  return schema.parse(parsed);
};
function firstPanes(): Spec[] {
  const commands = fromEnv("MUX_PANES", Commands) ?? (hasVim ? [[shell], ["vim"]] : [[shell]]);
  const apps = fromEnv("MUX_APPS", Apps) ?? [];
  return [
    ...commands.map((command): Spec => ({ kind: "terminal", command })),
    ...apps.map((app): Spec => ({ kind: "app", ...app })),
  ];
}
const titleOf = (pane: Pane) =>
  pane.kind === "terminal" ? pane.command.join(" ") : `${pane.name} (airtty)`;

/**
 * An airtty application in a pane: its own bundle evaluation and instance key
 * (`openApplication`), disposed with the pane. Ctrl+C in it closes the pane, as a program
 * ends on Ctrl+C in a terminal pane.
 */
function AppPane({
  pane,
  active,
  onClose,
}: {
  pane: Pane & { kind: "app" };
  active: boolean;
  onClose: () => void;
}) {
  const [app, setApp] = useState<Application | undefined>();
  const [failure, setFailure] = useState("");
  const { client, url } = pane;
  const close = useRef(onClose);
  useLayoutEffect(() => {
    close.current = onClose;
  });
  useEffect(() => {
    let opened: Application | undefined;
    let closed = false;
    openApplication({ client, url }).then(
      (created) => {
        if (closed) return created.dispose();
        created.quit = () => close.current();
        opened = created;
        setApp(created);
      },
      (error: unknown) => setFailure(String(error)),
    );
    return () => {
      closed = true;
      opened?.dispose();
    };
  }, [client, url]);
  if (failure) return <text fg="#ff6b6b">{failure}</text>;
  if (!app) return <text fg="#8b98a5">Opening {pane.name}…</text>;
  return <Embed app={app} name={pane.name} active={active} prefix={PREFIX} flexGrow={1} />;
}

/**
 * A small tmux: panes side by side, each a local program on a PTY or an airtty
 * application inline. Ctrl+O is the only key the host keeps, for terminals and
 * applications alike; the sequences it starts (`ctrl+oo`) are ordinary keymap bindings.
 * Everything else, Ctrl+C included, goes to the active pane.
 */
export function Mux({ children }: { children: ReactNode }) {
  const app = useApplication();
  const [{ panes, active }, setMux] = useState(() => {
    const first = firstPanes().map((spec, id): Pane => ({ ...spec, id }));
    return { panes: first, active: 0, next: first.length };
  });
  const pending = usePendingSequence();
  const open = (command: readonly string[]) =>
    setMux((m) => ({
      panes: [...m.panes, { kind: "terminal", command, id: m.next }],
      active: m.next,
      next: m.next + 1,
    }));
  // Closing a pane unmounts its <Terminal> (its program is hung up) or its <Embed> (its
  // Application is disposed); the pane on its left takes the keys.
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
  // The last pane closed: so does the multiplexer, as tmux does.
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
            title={` ${pane.id} · ${titleOf(pane)} `}
            onMouseDown={() => focus(pane.id)}
          >
            {pane.kind === "terminal" ? (
              <Terminal
                command={pane.command}
                active={pane.id === active}
                prefix={PREFIX}
                flexGrow={1}
                onExit={() => close(pane.id)}
              />
            ) : (
              <AppPane pane={pane} active={pane.id === active} onClose={() => close(pane.id)} />
            )}
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
