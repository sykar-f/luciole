"use client";
import { useState } from "react";
import { Input, useApplication, useBindings } from "luciole/client";
import { installApp, launchTarget, removeApp, searchApps, updateApps } from "../actions/launcher";
import type { Found, InstalledApp, Outcome } from "./model";
import { color } from "./theme";

type Pane = "query" | "installed" | "found";
const PANES: readonly Pane[] = ["query", "installed", "found"];
const LIST_HEIGHT = 8;
// Typed text that names something to launch rather than words to search for: a path,
// a git source or a URL (src/launcher/target.ts decides for real).
const TARGET = /^[.~/]|:/;

/**
 * `luciole` without arguments: installed apps, a registry search, and a field that also
 * takes any target `luciole <target>` would. Choosing an app hands it to `luciole`, which
 * launches it once this Client has quit, then comes back here.
 */
export function Launcher({
  installed,
  notice,
  registry,
}: {
  installed: InstalledApp[];
  notice?: string;
  registry: string;
}) {
  const app = useApplication();
  const [pane, setPane] = useState<Pane>(installed.length ? "installed" : "query");
  const [query, setQuery] = useState("");
  const [found, setFound] = useState<Found[]>();
  const [picked, setPicked] = useState({ installed: 0, found: 0 });
  const [status, setStatus] = useState<{ text: string; failed?: boolean } | undefined>(
    notice ? { text: notice } : undefined,
  );
  const [busy, setBusy] = useState(false);

  async function run<T>(label: string, action: () => Promise<Outcome<T>>) {
    if (busy) return undefined;
    setBusy(true);
    setStatus({ text: `${label}…` });
    try {
      const result = await action();
      if (!result.ok) {
        setStatus({ text: result.error, failed: true });
        return undefined;
      }
      setStatus(undefined);
      return result.value;
    } catch {
      // A transport failure: the heading already shows the connection's state.
      setStatus({ text: `${label} failed`, failed: true });
      return undefined;
    } finally {
      setBusy(false);
    }
  }
  async function launch(target: string) {
    if ((await run(`Opening ${target}`, () => launchTarget(target))) !== undefined) app.quit?.();
  }
  async function submit(text: string) {
    const typed = text.trim();
    if (TARGET.test(typed)) return launch(typed);
    const hits = await run(typed ? `Searching ${typed}` : "Listing apps", () => searchApps(typed));
    if (!hits) return;
    setFound(hits);
    setPicked((p) => ({ ...p, found: 0 }));
    if (hits.length) setPane("found");
    else setStatus({ text: `No app matches "${typed}" on ${registry}` });
  }
  async function install(hit: Found, then: "launch" | "stay") {
    const name = await run(`Installing ${hit.package}`, () => installApp(hit.package));
    if (name === undefined) return;
    if (then === "launch") return launch(name);
    setStatus({ text: `${name} installed` });
  }
  const current = installed[picked.installed];
  const hit = found?.[picked.found];
  const done = (text: string | undefined) => text !== undefined && setStatus({ text });
  const cycle = (step: number) =>
    setPane((p) => PANES[(PANES.indexOf(p) + step + PANES.length) % PANES.length] ?? "query");

  useBindings(
    () => ({
      bindings: [
        { key: "tab", cmd: () => cycle(1), desc: "next pane", group: "launcher" },
        { key: "shift+tab", cmd: () => cycle(-1) },
        ...(pane === "installed" && current
          ? [
              {
                key: "u",
                cmd: async () =>
                  done(await run(`Updating ${current.app}`, () => updateApps([current.app]))),
                desc: "update",
                group: "launcher",
              },
              {
                key: "shift+u",
                cmd: async () => done(await run("Updating every app", () => updateApps([]))),
                desc: "update all",
                group: "launcher",
              },
              {
                key: "x",
                cmd: async () => {
                  const removed = await run(`Removing ${current.app}`, () =>
                    removeApp(current.app),
                  );
                  if (removed === undefined) return;
                  setPicked((p) => ({ ...p, installed: 0 }));
                  setStatus({ text: `${removed} removed` });
                },
                desc: "remove",
                group: "launcher",
              },
            ]
          : []),
        ...(pane === "found" && hit
          ? [{ key: "i", cmd: () => install(hit, "stay"), desc: "install", group: "launcher" }]
          : []),
      ],
    }),
    [pane, current, hit, busy],
  );

  const focus = (p: Pane) => pane === p && !busy;
  return (
    <box flexDirection="column" gap={1} flexGrow={1}>
      <box
        border
        borderColor={focus("query") ? color.accent : color.border}
        height={3}
        flexShrink={0}
        title=" search the registry, or launch ./path · github:user/repo "
      >
        <Input
          id="launcher-query"
          name="launcher/query"
          focused={focus("query")}
          value={query}
          onInput={setQuery}
          // Enter can come before the change it follows is reported: the field's own value.
          onSubmit={(value) => void submit(typeof value === "string" ? value : query)}
          placeholder="Enter lists every app"
        />
      </box>
      <text fg={pane === "installed" ? color.accent : color.muted}>
        INSTALLED ({installed.length})
      </text>
      {installed.length ? (
        <select
          id="launcher-installed"
          focused={focus("installed")}
          height={Math.min(LIST_HEIGHT, installed.length * 2)}
          selectedIndex={Math.min(picked.installed, installed.length - 1)}
          options={installed.map((a) => ({
            name: a.app,
            description: `${a.package}@${a.version}${a.range ? ` (follows ${a.range})` : ""}`,
            value: a.app,
          }))}
          onChange={(index) => setPicked((p) => ({ ...p, installed: index }))}
          onSelect={(_index, option) => {
            if (option) void launch(String(option.value));
          }}
        />
      ) : (
        <text fg={color.muted}>Nothing yet: search the registry above.</text>
      )}
      {found ? (
        <>
          <text fg={pane === "found" ? color.accent : color.muted}>
            ON {registry} ({found.length})
          </text>
          {found.length ? (
            <select
              id="launcher-found"
              focused={focus("found")}
              height={Math.min(LIST_HEIGHT, found.length * 2)}
              selectedIndex={Math.min(picked.found, found.length - 1)}
              options={found.map((f) => ({
                name: `${f.package}@${f.version}`,
                description: f.description ?? "",
                value: f.package,
              }))}
              onChange={(index) => setPicked((p) => ({ ...p, found: index }))}
              onSelect={(index) => {
                const chosen = found[index];
                if (chosen) void install(chosen, "launch");
              }}
            />
          ) : null}
        </>
      ) : null}
      <text id="launcher-status" fg={status?.failed ? color.warn : color.muted}>
        {status?.text ??
          (pane === "installed"
            ? "Enter launches · u update · shift+u update all · x remove"
            : pane === "found"
              ? "Enter installs and launches · i installs"
              : "Enter searches, or launches a path, git source or URL")}
      </text>
    </box>
  );
}
