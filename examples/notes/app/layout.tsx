"use client";
import { useState, type ReactNode } from "react";
import { useTerminalDimensions } from "@opentui/react";
import {
  DebugOverlay,
  useBindings,
  useConnection,
  type LayoutProps,
} from "@luciole-sh/core/client";
import { useCommands } from "../components/commands";
import { Drawer } from "../components/Drawer";
import { sidebarWidth } from "../components/format";
import { NewNoteButton, Sidebar } from "../components/Sidebar";
import { WindowStatusProvider } from "../components/StatusLine";
import { PaletteProvider, usePalette } from "../components/theme";
import {
  ICON_BUTTON_HEIGHT,
  ICON_BUTTON_WIDTH,
  IconButton,
  Line,
  MenuLayer,
  ToastLayer,
} from "../components/ui";
import { ui, useUi } from "../components/ui-state";

// The notebook's window: the list of notes on the left, the note on the right, nothing
// across the top: every row goes to the text. What a toolbar would say, the line above the
// note's title says (components/StatusLine.tsx), and what it would hold sits by the list.
// Persistent: the list, the search and the folded sidebar survive every navigation.
export default function Layout({ children }: LayoutProps) {
  return (
    <PaletteProvider>
      <WindowStatusProvider>
        <Window>{children}</Window>
      </WindowStatusProvider>
    </PaletteProvider>
  );
}
/**
 * The folded list: its ≡ (drawn by the window) on the end of the list's bar, then "+", as
 * far below it as the notes are.
 */
const RAIL_WIDTH = ICON_BUTTON_WIDTH + 2;
function Rail() {
  const color = usePalette();
  return (
    <box id="rail" flexDirection="column" width={RAIL_WIDTH}>
      <box height={ICON_BUTTON_HEIGHT} flexShrink={0} backgroundColor={color.button} />
      <box flexShrink={0} paddingX={1} marginTop={1}>
        <NewNoteButton />
      </box>
    </box>
  );
}

function Window({ children }: { children: ReactNode }) {
  const { error, buildError, refresh } = useConnection();
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
  return (
    <box flexDirection="column" flexGrow={1}>
      {buildError || error ? (
        <box paddingX={2} flexShrink={0}>
          <Line fg={color.warn}>{buildError || error}</Line>
        </box>
      ) : null}
      {debug ? <DebugOverlay /> : null}
      <box flexDirection="row" flexGrow={1}>
        <box id="list-panel" flexDirection="row" flexShrink={0} backgroundColor={color.sidebar}>
          <Drawer
            open={sidebar}
            width={sidebarWidth(width, true)}
            railWidth={RAIL_WIDTH}
            rail={<Rail />}
          >
            <Sidebar width={sidebarWidth(width, true)} />
          </Drawer>
          {/* Over the panel, not in it: the ≡ never moves, whether the list is open, shut or
              sliding, so a second click lands on it again. */}
          <box position="absolute" left={1} top={0} zIndex={1}>
            <IconButton id="toggle-sidebar" icon="≡" tone="quiet" onPress={ui.toggleSidebar} />
          </box>
        </box>
        <box id="page" flexDirection="column" flexGrow={1}>
          {children}
        </box>
      </box>
      <MenuLayer />
      <ToastLayer />
    </box>
  );
}
