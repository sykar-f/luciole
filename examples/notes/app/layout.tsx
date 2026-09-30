"use client";
import { useState, type ReactNode } from "react";
import type { BoxRenderable } from "@opentui/core";
import { useTerminalDimensions } from "@opentui/react";
import {
  DebugOverlay,
  useApplication,
  useBindings,
  useConnection,
  type LayoutProps,
} from "luciole/client";
import { useCommands } from "../components/commands";
import { Drawer } from "../components/Drawer";
import { sidebarWidth } from "../components/format";
import { Sidebar } from "../components/Sidebar";
import { PaletteProvider, usePalette } from "../components/theme";
import { ActionsSlotProvider, Separator } from "../components/Toolbar";
import { Button, Line, MenuLayer, ToastLayer } from "../components/ui";
import { ui, useUi } from "../components/ui-state";

// The notebook's window: a toolbar across the top, the list of notes on the left, the note on the right.
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
  const [actions, setActions] = useState<BoxRenderable | null>(null);
  // Shortcuts for those who look for them; the screen never lists them.
  useBindings(
    () => ({
      bindings: [
        { key: "ctrl+r", cmd: () => void refresh() },
        { key: "ctrl+t", cmd: () => setDebug((shown) => !shown) },
        { key: "ctrl+n", cmd: () => void commands.create() },
        // Ctrl+L for the list: Ctrl+B is bold, in the note.
        { key: "ctrl+l", cmd: ui.toggleSidebar },
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
    <ActionsSlotProvider value={actions}>
      <box flexDirection="column" flexGrow={1}>
        <box
          id="toolbar"
          flexDirection="row"
          height={3}
          flexShrink={0}
          gap={1}
          paddingX={1}
          paddingY={1}
          backgroundColor={color.sidebar}
        >
          <Button id="toggle-sidebar" tone="quiet" onPress={ui.toggleSidebar}>
            {sidebar ? "◧ Hide list" : "◧ Show list"}
          </Button>
          <Button id="new-note" tone="primary" onPress={() => void commands.create()}>
            + New note
          </Button>
          {/* Filled by the note on screen: Copy, Delete, Edit or Done. */}
          <box id="note-actions" ref={setActions} flexDirection="row" flexShrink={0} gap={1} />
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
          {/* Said only when it goes wrong: a working connection needs no word. */}
          {online ? null : (
            <>
              <text id="connection" flexShrink={0} wrapMode="none" fg={color.warn}>
                ○ {status}
              </text>
              <Button tone="quiet" onPress={() => void refresh()}>
                Reconnect
              </Button>
            </>
          )}
          {/* A terminal has no close button of its own; a window or a page does. */}
          {app.quit && app.options.quitOnCtrlC !== false ? (
            <>
              <Separator />
              <Button tone="quiet" onPress={() => app.quit?.()}>
                Quit
              </Button>
            </>
          ) : null}
        </box>
        {buildError || error ? (
          <box paddingX={2}>
            <Line fg={color.warn}>{buildError || error}</Line>
          </box>
        ) : null}
        {debug ? <DebugOverlay /> : null}
        <box flexDirection="row" flexGrow={1}>
          <Drawer open={sidebar} width={sidebarWidth(width, true)}>
            <Sidebar width={sidebarWidth(width, true)} />
          </Drawer>
          <box id="page" flexDirection="column" flexGrow={1}>
            {children}
          </box>
        </box>
        <MenuLayer />
        <ToastLayer />
      </box>
    </ActionsSlotProvider>
  );
}
