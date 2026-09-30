"use client";
import { useEffect, useState } from "react";
import { useRenderer, useTerminalDimensions } from "@opentui/react";
import { useBindings } from "luciole/client";
import type { ComponentNode } from "../../schema";
import { openInEditor } from "./editor";
import { useDevtools, useTicker } from "./store";
import { color, fit, Line, useSelection } from "./ui";

/**
 * React DevTools' Components tab, with the Server Components Flight described and what
 * React DevTools does not say: why each component rendered and whether it had to.
 * Rows flash as their component renders; `h` flashes them in the application's own
 * terminal too, and the selected component is outlined there.
 */
type Command = (role: string, suffix: string, payload: unknown) => Promise<unknown>;
const FLASH_MS = 800;
const TICK_MS = 100;
const PROP_WIDTH = 40;
const HOOK_LINES = 3;
const DETAIL_LINES = 11,
  CHROME_LINES = 6;
/**
 * Framework and router plumbing, hidden by default (`a` shows it): OpenTUI's root
 * boundary, the Shell's providers, TanStack Router's matches, outlets and boundaries,
 * and the page loader's own component.
 */
const PLUMBING = new Set([
  "ErrorBoundary",
  "Shell",
  "KeymapProvider",
  "Runtime",
  "RouterProvider",
  "RouterContextProvider",
  "Matches",
  "MatchesInner",
  "Match",
  "MatchView",
  "MatchInner",
  "MatchInnerImpl",
  "MatchImpl",
  "Outlet",
  "OutletImpl",
  "CatchBoundary",
  "CatchBoundaryImpl",
  "CatchNotFound",
  "SafeFragment",
  "Transitioner",
  "OnRendered",
  "ScrollRestoration",
  "LayoutRoute",
  "Page",
  "PageLoading",
  "Suspense",
  "component",
  "Anonymous",
]);
// The bundler suffixes a name it had to rename (`Page2`): plumbing either way.
const isPlumbing = (name: string) => PLUMBING.has(name) || PLUMBING.has(name.replace(/\d+$/, ""));

/** The tree without plumbing: a hidden node's children move up to its visible ancestor. */
function visibleTree(nodes: readonly ComponentNode[], showAll: boolean, unnecessaryOnly: boolean) {
  if (showAll && !unnecessaryOnly) return nodes.map((n) => ({ node: n, depth: n.depth }));
  const depth = new Map<number, number>();
  const out: { node: ComponentNode; depth: number }[] = [];
  for (const node of nodes) {
    const parentDepth = node.parent === null ? -1 : (depth.get(node.parent) ?? -1);
    const hidden = !showAll && node.kind === "client" && isPlumbing(node.name);
    depth.set(node.id, hidden ? parentDepth : parentDepth + 1);
    if (hidden || (unnecessaryOnly && !node.unnecessary)) continue;
    out.push({ node, depth: parentDepth + 1 });
  }
  return out;
}

export function ComponentsPanel({ command }: { command: Command }) {
  const store = useDevtools();
  const { height } = useTerminalDimensions();
  const [showAll, setShowAll] = useState(false);
  const [highlight, setHighlight] = useState(false);
  const [unnecessaryOnly, setUnnecessaryOnly] = useState(false);
  const [notice, setNotice] = useState("");
  const renderer = useRenderer();
  const commit = store.session.components();
  const nodes = commit?.nodes ?? [];
  const tree = visibleTree(nodes, showAll, unnecessaryOnly);
  // Rows flash for a moment after each commit, then settle.
  const now = useTicker(TICK_MS, false, { key: commit?.at, duration: FLASH_MS });
  const list = useSelection(tree, height - CHROME_LINES - DETAIL_LINES);
  const selected = list.selected?.node;
  const selectedSource = selected ? store.session.sourceOf(selected) : undefined;
  // The selected component is outlined in the application's terminal.
  useEffect(() => {
    void command("client", "select", { id: selected?.id ?? null }).catch(() => {});
  }, [selected?.id, command]);
  useEffect(() => () => void command("client", "select", { id: null }).catch(() => {}), [command]);
  const flash = (enabled: boolean, only: boolean) =>
    void command("client", "highlight", { enabled, unnecessaryOnly: only }).catch(() => {});
  useBindings(
    () => ({
      bindings: [
        {
          key: "h",
          cmd: () => {
            setHighlight(!highlight);
            flash(!highlight, unnecessaryOnly);
          },
          desc: highlight ? "stop flashing app" : "flash app",
          group: "panel",
        },
        {
          key: "u",
          cmd: () => {
            setUnnecessaryOnly(!unnecessaryOnly);
            if (highlight) flash(true, !unnecessaryOnly);
          },
          desc: unnecessaryOnly ? "all renders" : "unnecessary only",
          group: "panel",
        },
        ...(selectedSource
          ? [
              {
                key: "o",
                cmd: () =>
                  setNotice(
                    openInEditor(renderer, store.session.root(), selectedSource, selected?.file),
                  ),
                desc: "open in editor",
                group: "panel",
              },
            ]
          : []),
        {
          key: "a",
          cmd: () => setShowAll(!showAll),
          desc: showAll ? "hide plumbing" : "show plumbing",
          group: "panel",
        },
      ],
    }),
    [highlight, unnecessaryOnly, showAll, selectedSource, selected?.file, renderer, store],
  );

  const unavailable = store.session.componentsUnavailable();
  if (!commit)
    return (
      <box flexDirection="column" flexGrow={1}>
        <Line fg={unavailable ? color.warn : color.faint}>{unavailable ?? "No commit yet."}</Line>
      </box>
    );
  const unnecessary = nodes.filter((n) => n.unnecessary).length;
  return (
    <box flexDirection="column" flexGrow={1}>
      <Line fg={color.muted}>
        {`${nodes.length} components · ${unnecessary} unnecessary last render · ${highlight ? "flashing in app" : "h to flash in app"}${unnecessaryOnly ? " · unnecessary only" : ""}`}
      </Line>
      <box flexDirection="column" flexGrow={1} overflow="hidden">
        {list.visible.map(({ node, depth }, i) => {
          const isSelected = list.first + i === list.index;
          const since = node.renderedAt === undefined ? Infinity : now - node.renderedAt;
          // Fades: bright right after the render, then dim, then gone.
          const bg = isSelected
            ? color.selected
            : since < FLASH_MS / 2
              ? color.flash
              : since < FLASH_MS
                ? color.fade
                : undefined;
          return (
            <text key={node.id} height={1} flexShrink={0} wrapMode="none" truncate bg={bg}>
              <span fg={color.faint}>{"  ".repeat(depth)}</span>
              <span fg={node.kind === "server" ? color.server : color.text}>
                {node.kind === "server" ? `◇ ${node.name}` : node.name}
              </span>
              {node.kind === "server" ? (
                <span fg={color.server}>{` ${node.env ?? "Server"}`}</span>
              ) : null}
              {node.key ? <span fg={color.faint}>{` key=${node.key}`}</span> : null}
              {store.session.sourceOf(node) ? (
                <span fg={color.faint}>{` · ${store.session.sourceOf(node)}`}</span>
              ) : null}
              {node.renders ? <span fg={color.muted}>{` ×${node.renders}`}</span> : null}
              {node.unnecessary ? <span fg={color.warn}> ⚠ unnecessary</span> : null}
              {node.reason && !node.unnecessary && node.reason !== "mount" ? (
                <span fg={color.faint}>{` ${node.reason}`}</span>
              ) : null}
            </text>
          );
        })}
      </box>
      <Inspector node={selected} source={selectedSource} notice={notice} />
    </box>
  );
}

function Inspector({
  node,
  source,
  notice,
}: {
  node: ComponentNode | undefined;
  source: string | undefined;
  notice: string;
}) {
  if (!node) return <box height={DETAIL_LINES} flexShrink={0} />;
  const props = Object.entries(node.props ?? {});
  return (
    <box
      flexDirection="column"
      height={DETAIL_LINES}
      flexShrink={0}
      border={["top"]}
      borderColor={color.faint}
    >
      <Line>
        {`${node.name} · ${node.kind === "server" ? `Server Component (${node.env ?? "Server"}), from Flight` : `${node.renders} renders · last: ${node.reason ?? "–"}`}${node.rect ? ` · ${node.rect.width}×${node.rect.height} at ${node.rect.x},${node.rect.y}` : ""}`}
      </Line>
      {node.unnecessary ? (
        <Line fg={color.warn}>
          Rendered with equal props, state and context: memo() would have skipped it.
        </Line>
      ) : null}
      <Line fg={color.accent}>props</Line>
      <Line fg={color.muted}>
        {props.length
          ? props.map(([k, v]) => `${k}=${fit(v, PROP_WIDTH).trimEnd()}`).join("  ")
          : "–"}
      </Line>
      <Line fg={color.accent}>hooks</Line>
      <text height={HOOK_LINES} flexShrink={0} wrapMode="word" fg={color.muted}>
        {node.hooks?.length ? node.hooks.join(" · ") : "–"}
      </text>
      <Line fg={color.faint}>{notice || (source ? `${source} · o opens it in $EDITOR` : "")}</Line>
    </box>
  );
}
