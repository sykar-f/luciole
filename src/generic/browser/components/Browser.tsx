"use client";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import * as z from "zod/mini";
import {
  Embed,
  openApplication,
  useApplication,
  useBindings,
  type Application,
} from "airtty/client";
import { openSession, type SessionStore } from "../../../session";

/**
 * The generic Client (docs/EMBEDDING.md, step 5): each origin the launcher prepared
 * (src/generic/prepare.ts) in a tab, inline. Ctrl+O is the host's only key.
 */
const PREFIX = "ctrl+o";
const Tab = z.object({
  url: z.string(),
  origin: z.string(),
  name: z.string(),
  app: z.string(),
  fingerprint: z.string(),
  sessions: z.string(),
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
 * Ctrl+C in it closes its tab.
 */
function OriginTab({ tab, active, onClose }: { tab: Tab; active: boolean; onClose: () => void }) {
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
      if (open.has(forget)) save();
      process.off("exit", save);
      open.delete(forget);
      opened?.dispose();
    };
  }, [tab]);
  if (failure) return <text fg="#ff6b6b">{failure}</text>;
  if (!app) return <text fg="#8b98a5">Opening {tab.origin}…</text>;
  return <Embed app={app} name={tab.name} active={active} prefix={PREFIX} flexGrow={1} />;
}

export function Browser({ children }: { children: ReactNode }) {
  const host = useApplication();
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
  const empty = tabs.length === 0;
  useEffect(() => {
    if (empty) host.quit?.();
  }, [host, empty]);
  useBindings(
    () => ({
      bindings: [
        { key: `${PREFIX}o`, cmd: cycle, desc: "next tab", group: "browser" },
        { key: `${PREFIX}x`, cmd: () => close(active), desc: "close tab", group: "browser" },
        { key: `${PREFIX}q`, cmd: quit, desc: "quit", group: "browser" },
      ],
    }),
    [host, active],
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
      {tabs.map((tab) => (
        <box key={tab.id} flexGrow={1} flexDirection="column" visible={tab.id === active}>
          <OriginTab tab={tab} active={tab.id === active} onClose={() => close(tab.id)} />
        </box>
      ))}
      <box flexDirection="row" height={1} flexShrink={0} gap={2}>
        <text id="browser-status" wrapMode="none" fg="#ffbc66">
          inline · confiance totale · aucune capacité appliquée
        </text>
        {children}
      </box>
    </box>
  );
}
