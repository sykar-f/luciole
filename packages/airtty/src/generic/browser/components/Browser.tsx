"use client";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import * as z from "zod/mini";
import type { KeyEvent } from "@opentui/core";
import { useRenderer } from "@opentui/react";
import {
  Embed,
  openApplication,
  useApplication,
  useBindings,
  type Application,
} from "airtty/client";
import { Capabilities } from "../../../capabilities";
import { messageOf } from "../../../guards";
import { enforcement, ENFORCERS } from "../../../sandbox/grants";
import { mechanismName } from "../../../sandbox/mechanism";
import type { Question } from "../../../sandbox/permissions";
import { openSandbox, type Sandbox } from "../../../sandbox/spawn";
import { readOrigin, writeOrigin } from "../../origin";
import { openSession, type SessionStore } from "../../../session";
import { TerminalView } from "../../../vt/terminal";
import { createHub, inlineChannel, type Hub } from "../../hub";

/**
 * The generic Client (docs/EMBEDDING.md, steps 5 and 7): each origin the launcher
 * prepared (src/generic/prepare.ts) in a tab, inline or sandboxed. Ctrl+O is the host's
 * only key.
 */
const PREFIX = "ctrl+o";
const Tab = z.object({
  url: z.string(),
  origin: z.string(),
  name: z.string(),
  app: z.string(),
  fingerprint: z.string(),
  sessions: z.string(),
  mode: z.enum(["inline", "sandbox"]),
  granted: Capabilities,
  denied: z.optional(z.array(z.string())),
  /** Sandboxed tabs: Bun, airtty and the built child, found by the launcher. */
  runtime: z.optional(
    z.object({
      bun: z.string(),
      libraries: z.array(z.string()),
      code: z.array(z.string()),
    }),
  ),
  child: z.optional(z.string()),
  /** What confines it (src/sandbox/mechanism.ts). */
  mechanism: z.optional(
    z.union([
      z.object({ kind: z.literal("seatbelt") }),
      z.object({
        kind: z.enum(["userns", "bwrap", "landlock"]),
        landlockAbi: z.number(),
        launcher: z.string(),
        bwrap: z.optional(z.string()),
      }),
    ]),
  ),
});
type Tab = z.infer<typeof Tab>;
function tabsFromEnvironment(): Tab[] {
  const text = process.env.AIRTTY_GENERIC_TABS;
  if (!text) return [];
  const parsed: unknown = JSON.parse(text);
  return z.array(Tab).parse(parsed);
}

// How to forget each open tab's session, for a purposeful quit to forget them all.
const open = new Set<() => void>();

/**
 * One origin: its bundle evaluated against this runtime, refused unless signed by the
 * key the launcher pinned, with the origin's own sessions (history and named fields).
 * Ctrl+C in it closes its tab, as it quits the host (not in a desktop window).
 */
type TabProps = {
  tab: Tab;
  id: number;
  hub: Hub;
  active: boolean;
  onClose: () => void;
  /** Asks the user about a capability the tab's application requests. */
  ask: (question: Question) => Promise<boolean>;
  /** The tab's grants changed (the user answered): for the status line. */
  onGrants: (granted: Capabilities) => void;
};
function OriginTab({ tab, id, hub, active, onClose }: TabProps) {
  const { quitOnCtrlC } = useApplication().options;
  const [app, setApp] = useState<Application | undefined>();
  const [failure, setFailure] = useState("");
  const close = useRef(onClose);
  useLayoutEffect(() => {
    close.current = onClose;
  });
  useEffect(() => {
    let opened: Application | undefined;
    let closed = false;
    // Sessions of this origin only, keyed by the origin as the user gave it.
    const session: SessionStore = openSession({ name: tab.sessions, server: tab.origin });
    // Its `host` requests, answered here: inline, nothing is enforced.
    const channel = inlineChannel(hub, id, tab.origin);
    // A signal or a crash ends the process without unmounting: save first.
    const save = () => {
      if (opened) session.flush(opened.restoration.snapshot());
    };
    process.on("exit", save);
    // Quitting on purpose deletes the session, and nothing may write it back at exit.
    const forget = () => {
      process.off("exit", save);
      open.delete(forget);
      session.remove();
    };
    open.add(forget);
    openApplication({
      bundle: tab.app,
      url: tab.url,
      session: session.restored,
      host: channel,
      quitOnCtrlC,
      publisher: {
        required: true,
        trust: (fingerprint) => {
          if (fingerprint !== tab.fingerprint)
            throw new Error(`${tab.origin}: the bundle is not signed by the pinned key`);
        },
      },
    }).then(
      (created) => {
        if (closed) return created.dispose();
        opened = created;
        session.flush(created.restoration.snapshot());
        created.restoration.subscribe(() => session.schedule(created.restoration.snapshot()));
        created.quit = () => {
          forget();
          close.current();
        };
        setApp(created);
      },
      (error: unknown) => setFailure(String(error)),
    );
    return () => {
      closed = true;
      channel.close();
      if (open.has(forget)) save();
      process.off("exit", save);
      open.delete(forget);
      opened?.dispose();
    };
  }, [tab, id, hub, quitOnCtrlC]);
  if (failure) return <text fg="#ff6b6b">{failure}</text>;
  if (!app) return <text fg="#8b98a5">Opening {tab.origin}…</text>;
  return <Embed app={app} name={tab.name} active={active} prefix={PREFIX} flexGrow={1} />;
}

/**
 * One origin in the sandbox (src/sandbox): its Client runs in a process of its own under
 * Seatbelt, shown by the VT widget; what it asks of `host` arrives over IPC and is
 * checked against its grants. Its end (Ctrl+C in it, outside a desktop window) closes
 * the tab.
 */
function SandboxTab({ tab, id, hub, active, onClose, ask, onGrants }: TabProps) {
  const [sandbox, setSandbox] = useState<Sandbox | undefined>();
  const [failure, setFailure] = useState("");
  const close = useRef(onClose);
  const latest = useRef({ ask, onGrants });
  useLayoutEffect(() => {
    close.current = onClose;
    latest.current = { ask, onGrants };
  });
  useEffect(() => {
    const { runtime, child, mechanism } = tab;
    if (!runtime || !child || !mechanism) return;
    let opened: Sandbox | undefined;
    let closed = false;
    let leave = () => {};
    openSandbox(
      { ...tab, runtime, child, mechanism },
      {
        perform: hub.perform(id, tab.origin),
        ask: (question) => latest.current.ask(question),
        // The user's answer is remembered for the origin, as its accepted grants are.
        onChange: () => {
          if (!opened) return;
          const record = readOrigin(tab.origin);
          const { permissions } = opened;
          if (record)
            writeOrigin({
              ...record,
              granted: permissions.granted(),
              denied: permissions.denied(),
            });
          latest.current.onGrants(permissions.granted());
        },
      },
    ).then(
      (created) => {
        if (closed) return void created.close();
        opened = created;
        leave = hub.join(id, {
          origin: tab.origin,
          hears: (event) => created.permissions.hears(event),
          deliver: (event) => created.deliver(event),
        });
        setSandbox(created);
      },
      (error: unknown) => setFailure(`${tab.origin}: ${messageOf(error)}`),
    );
    return () => {
      closed = true;
      leave();
      void opened?.close();
    };
  }, [tab, id, hub]);
  if (!tab.runtime || !tab.child || !tab.mechanism)
    return <text fg="#ff6b6b">{tab.origin}: no sandbox runtime was prepared</text>;
  if (failure) return <text fg="#ff6b6b">{failure}</text>;
  if (!sandbox) return <text fg="#8b98a5">Opening {tab.origin} in the sandbox…</text>;
  return (
    <TerminalView
      program={tab.origin}
      label={tab.name}
      spawn={(io) => sandbox.spawn(io)}
      active={active}
      prefix={PREFIX}
      onExit={() => close.current()}
      flexGrow={1}
    />
  );
}

/** What the status line says of the active tab: who enforces what, or nothing. */
function statusOf(tab: Tab | undefined, granted: Capabilities | undefined) {
  if (!tab) return "";
  if (tab.mode === "inline" || !tab.mechanism)
    return "inline · confiance totale · aucune capacité appliquée";
  const lines = enforcement(granted ?? tab.granted, tab.mechanism).map(
    (line) => `${line.capability.split(" ")[0]} (${ENFORCERS[line.by]})`,
  );
  // Short: the line shares its row with the help.
  const network = tab.mechanism.kind === "landlock" ? ", réseau non confiné" : "";
  return `sandbox · ${mechanismName(tab.mechanism)}${network} · ${lines.length ? lines.join(", ") : "aucune capacité accordée"}`;
}

export function Browser({ children }: { children: ReactNode }) {
  const host = useApplication();
  const renderer = useRenderer();
  const [hub] = useState(createHub);
  const [{ tabs, active }, setTabs] = useState(() => ({
    tabs: tabsFromEnvironment().map((tab, id) => ({ ...tab, id })),
    active: 0,
  }));
  const close = (id: number) =>
    setTabs((t) => {
      const at = t.tabs.findIndex((tab) => tab.id === id);
      if (at < 0) return t;
      const rest = t.tabs.filter((tab) => tab.id !== id);
      const neighbour = rest[Math.max(0, at - 1)]?.id ?? -1;
      return { tabs: rest, active: t.active === id ? neighbour : t.active };
    });
  const cycle = () =>
    setTabs((t) => {
      const at = t.tabs.findIndex((tab) => tab.id === t.active);
      return { ...t, active: t.tabs[(at + 1) % t.tabs.length]?.id ?? t.active };
    });
  // Quitting on purpose forgets every tab's session, as a browser closed by the user.
  const quit = () => {
    for (const forget of open) forget();
    host.quit?.();
  };
  // Grants the user added while the tabs run, and the questions waiting for an answer.
  const [live, setLive] = useState<ReadonlyMap<number, Capabilities>>(new Map());
  const [questions, setQuestions] = useState<
    readonly { id: number; origin: string; question: Question; answer: (yes: boolean) => void }[]
  >([]);
  const askFor = (id: number, origin: string) => (question: Question) =>
    new Promise<boolean>((resolve) =>
      setQuestions((q) => [...q, { id, origin, question, answer: resolve }]),
    );
  const reply = (yes: boolean) =>
    setQuestions(([first, ...rest]) => {
      first?.answer(yes);
      return rest;
    });
  const pending = questions[0];
  const empty = tabs.length === 0;
  useEffect(() => hub.focus(active), [hub, active]);
  // Keys the host sees go to the tabs without the focus that may hear them (input.global).
  useEffect(() => {
    const listener = (event: KeyEvent) => hub.key(event);
    renderer.keyInput.on("keypress", listener);
    return () => void renderer.keyInput.off("keypress", listener);
  }, [hub, renderer]);
  useEffect(() => {
    if (empty) host.quit?.();
  }, [host, empty]);
  useBindings(
    () => ({
      bindings: [
        { key: `${PREFIX}o`, cmd: cycle, desc: "next tab", group: "browser" },
        { key: `${PREFIX}x`, cmd: () => close(active), desc: "close tab", group: "browser" },
        { key: `${PREFIX}q`, cmd: quit, desc: "quit", group: "browser" },
        ...(pending
          ? [
              { key: `${PREFIX}y`, cmd: () => reply(true), desc: "grant", group: "browser" },
              { key: `${PREFIX}n`, cmd: () => reply(false), desc: "refuse", group: "browser" },
            ]
          : []),
      ],
    }),
    [host, active, pending],
  );
  return (
    <box flexDirection="column" flexGrow={1}>
      <box flexDirection="row" height={1} flexShrink={0} gap={2}>
        {tabs.map((tab) => (
          <text key={tab.id} wrapMode="none" fg={tab.id === active ? "#67d9bc" : "#526d82"}>
            {tab.id === active ? "▸ " : "  "}
            {tab.name} · {tab.origin}
          </text>
        ))}
      </box>
      {tabs.map((tab) => {
        const Pane = tab.mode === "sandbox" ? SandboxTab : OriginTab;
        return (
          <box key={tab.id} flexGrow={1} flexDirection="column" visible={tab.id === active}>
            <Pane
              tab={tab}
              id={tab.id}
              hub={hub}
              active={tab.id === active}
              onClose={() => close(tab.id)}
              ask={askFor(tab.id, tab.origin)}
              onGrants={(granted) => setLive((m) => new Map(m).set(tab.id, granted))}
            />
          </box>
        );
      })}
      <box flexDirection="row" height={1} flexShrink={0} gap={2}>
        <text id="browser-status" wrapMode="none" fg="#ffbc66">
          {pending
            ? `${pending.origin} demande ${[pending.question.capability, pending.question.detail].filter(Boolean).join(" ")} — Ctrl+O y accorder · Ctrl+O n refuser`
            : statusOf(
                tabs.find((tab) => tab.id === active),
                live.get(active),
              )}
        </text>
        {children}
      </box>
    </box>
  );
}
