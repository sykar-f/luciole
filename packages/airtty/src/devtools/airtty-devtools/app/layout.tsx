"use client";
import { KeyHelp, useBindings, useLocation, useNavigate, type LayoutProps } from "airtty/client";
import { clearEvents, exportRecording } from "../actions/bus";
import { DevtoolsProvider, useDevtools } from "../components/store";
import { color, Line } from "../components/ui";
import { useState, type ReactNode } from "react";

/** The panels, in tab order; each is a route, so the terminal's history covers them too. */
const PANELS = [
  { key: "1", to: "/", label: "Network" },
  { key: "2", to: "/components", label: "Components" },
  { key: "3", to: "/console", label: "Console" },
  { key: "4", to: "/router", label: "Router" },
  { key: "5", to: "/cache", label: "Cache" },
  { key: "6", to: "/input", label: "Input" },
  { key: "7", to: "/conditions", label: "Conditions" },
] as const;

export default function Layout({ children }: LayoutProps) {
  return (
    <DevtoolsProvider>
      <Chrome>{children}</Chrome>
    </DevtoolsProvider>
  );
}

function Chrome({ children }: { children: ReactNode }) {
  const store = useDevtools();
  const navigate = useNavigate();
  const pathname = useLocation({ select: (l) => l.pathname });
  const [notice, setNotice] = useState("");
  const current = Math.max(
    0,
    PANELS.findIndex((p) => p.to === pathname),
  );
  const go = (delta: number) => {
    const next = PANELS[(current + delta + PANELS.length) % PANELS.length];
    if (next) void navigate({ to: next.to });
  };
  useBindings(
    () => ({
      bindings: store.typing
        ? []
        : [
            ...PANELS.map((panel) => ({
              key: panel.key,
              cmd: () => void navigate({ to: panel.to }),
            })),
            { key: "tab", cmd: () => go(1), desc: "panel", group: "devtools" },
            { key: "shift+tab", cmd: () => go(-1) },
            {
              key: "p",
              cmd: () => store.togglePause(),
              desc: store.paused ? "resume" : "pause",
              group: "devtools",
            },
            {
              key: "shift+c",
              cmd: () => {
                store.clear();
                void clearEvents();
              },
              desc: "clear",
              group: "devtools",
            },
            {
              key: "shift+e",
              cmd: () =>
                void exportRecording().then(
                  (r) => setNotice(`Exported ${r.events} events: ${r.json} · ${r.har}`),
                  (e: unknown) => setNotice(`Export failed: ${String(e)}`),
                ),
              desc: "export",
              group: "devtools",
            },
          ],
    }),
    [current, store.paused, store.typing, navigate],
  );
  const sources = store.session.sources();
  const live = sources.filter((s) => s.connected && s.role);
  return (
    <box flexDirection="column" flexGrow={1} paddingLeft={1} paddingRight={1}>
      <text height={1} flexShrink={0} wrapMode="none" truncate>
        <span fg={color.accent}>AIRTTY DEVTOOLS </span>
        {PANELS.map((panel, i) => (
          <span
            key={panel.to}
            fg={i === current ? color.text : color.muted}
            bg={i === current ? color.selected : undefined}
          >
            {` ${panel.key} ${panel.label} `}
          </span>
        ))}
      </text>
      <text height={1} flexShrink={0} wrapMode="none" truncate fg={color.muted}>
        {sources.length === 0 ? <span fg={color.warn}>no application yet</span> : null}
        {sources
          .filter((s) => s.role)
          .map((s) => (
            <span
              key={s.id}
              fg={s.connected ? (s.role === "server" ? color.server : color.client) : color.faint}
            >
              {`${s.connected ? "●" : "○"} ${s.role} ${s.app ?? ""} ${s.pid ?? ""}  `}
            </span>
          ))}
        {store.paused ? <span fg={color.warn}>PAUSED </span> : null}
        {store.session.dropped() + store.missed ? (
          <span
            fg={color.warn}
          >{`${store.session.dropped() + store.missed} events dropped  `}</span>
        ) : null}
        {store.rejected ? <span fg={color.warn}>{`${store.rejected} rejected  `}</span> : null}
      </text>
      {live.length === 0 && store.connect ? (
        <box flexDirection="column" flexShrink={0} paddingTop={1} paddingBottom={1}>
          <Line fg={color.muted}>
            Start the application with these variables (or eval &quot;$(airtty devtools
            --env)&quot;):
          </Line>
          <Line fg={color.accent}>{`  AIRTTY_DEVTOOLS=${store.connect.address}`}</Line>
          {store.connect.hook ? (
            <Line fg={color.accent}>{`  BUN_OPTIONS=--preload=${store.connect.hook}`}</Line>
          ) : null}
          <Line fg={color.faint}>
            The preload enables the Components panel; everything else works without it.
          </Line>
        </box>
      ) : null}
      <box flexDirection="column" flexGrow={1}>
        {children}
      </box>
      {notice ? <Line fg={color.muted}>{notice}</Line> : null}
      <box height={1} flexShrink={0}>
        <KeyHelp inline groups={["devtools", "panel", "list", "airtty"]} />
      </box>
    </box>
  );
}
