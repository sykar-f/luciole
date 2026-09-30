"use client";
import { useState, type ReactNode } from "react";
import { useTerminalDimensions } from "@opentui/react";
import {
  DebugOverlay,
  useApplication,
  useBindings,
  useConnection,
  type LayoutProps,
} from "luciole/client";
import { useCommands } from "../components/commands";
import { sidebarWidth } from "../components/format";
import { Sidebar } from "../components/Sidebar";
import { PaletteProvider, usePalette } from "../components/theme";
import { Button, Line, MenuLayer, ToastLayer } from "../components/ui";
import { ui, useUi } from "../components/ui-state";

// The notebook's window: a toolbar, the list of notes on the left, the note on the right.
// Persistent: the list, the search and the folded sidebar survive every navigation.
export default function Layout({ children }: LayoutProps) {
  return (
    <PaletteProvider>
      <Window>{children}</Window>
    </PaletteProvider>
  );
}
function Window({ children }: { children: ReactNode }) {
  const app = useApplication();
  const { status, error, buildError, activity, refresh } = useConnection();
  const { sidebar } = useUi();
  const { width } = useTerminalDimensions();
  const color = usePalette();
  const commands = useCommands();
  const [debug, setDebug] = useState(false);
  // Shortcuts for those who look for them; the screen never lists them.
  useBindings(
    () => ({
      bindings: [
        { key: "ctrl+r", cmd: () => void refresh() },
        { key: "ctrl+t", cmd: () => setDebug((shown) => !shown) },
        { key: "ctrl+n", cmd: () => void commands.create() },
        { key: "ctrl+b", cmd: ui.toggleSidebar },
        {
          key: "ctrl+f",
          cmd: () => {
            if (!ui.get().sidebar) ui.toggleSidebar();
            ui.focus("search");
          },
        },
      ],
    }),
    [refresh, commands],
  );
  const online = status === "Connected";
  return (
    <box flexDirection="column" flexGrow={1}>
      <box
        id="toolbar"
        flexDirection="row"
        height={1}
        flexShrink={0}
        gap={1}
        paddingX={1}
        marginTop={1}
      >
        <Button id="toggle-sidebar" tone="quiet" onPress={ui.toggleSidebar}>
          {sidebar ? "◧ Hide list" : "◧ Show list"}
        </Button>
        <Button id="new-note" tone="primary" onPress={() => void commands.create()}>
          + New note
        </Button>
        <box flexGrow={1} />
        {activity === "navigate" ? (
          <>
            <text flexShrink={0} fg={color.muted}>
              Opening…
            </text>
            <Button tone="quiet" onPress={app.cancel}>
              Cancel
            </Button>
          </>
        ) : activity === "refresh" ? (
          <text flexShrink={0} fg={color.muted}>
            Syncing…
          </text>
        ) : null}
        <text id="connection" flexShrink={0} wrapMode="none" fg={online ? color.muted : color.warn}>
          <span fg={online ? color.ok : color.warn}>{online ? "●" : "○"}</span> {status}
        </text>
        {online ? null : (
          <Button tone="quiet" onPress={() => void refresh()}>
            Reconnect
          </Button>
        )}
        {/* A terminal has no close button of its own; a window or a page does. */}
        {app.quit && app.options.quitOnCtrlC !== false ? (
          <Button tone="quiet" onPress={() => app.quit?.()}>
            Quit
          </Button>
        ) : null}
      </box>
      {buildError || error ? (
        <box paddingX={2}>
          <Line fg={color.warn}>{buildError || error}</Line>
        </box>
      ) : null}
      {debug ? <DebugOverlay /> : null}
      <box flexDirection="row" flexGrow={1} marginTop={1}>
        {sidebar ? <Sidebar width={sidebarWidth(width, true)} /> : null}
        <box id="page" flexDirection="column" flexGrow={1}>
          {children}
        </box>
      </box>
      <MenuLayer />
      <ToastLayer />
    </box>
  );
}
