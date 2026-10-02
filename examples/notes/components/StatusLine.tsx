"use client";
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { useApplication, useConnection } from "@luciole-sh/core/client";
import { usePalette } from "./theme";
import { Button } from "./ui";

// The line above the title speaks for the page (its save) and for the window (its
// connection, what the router is doing), one message at a time: a lost connection first,
// since nothing else can be fixed without it, then the page's own words, then what the
// router is doing, which settles by itself.

/**
 * How long a lost connection goes unmentioned on its own: a refused request, then one
 * answered, is a moment's loss. Past 3 s, as for a failed save (NoteEditor), it is said;
 * at once over a page's warning, which has waited its own time already.
 */
const LOST_QUIET_MS = 3000;
/**
 * How long a refresh goes unmentioned: every save reads its note again, and a line that
 * says nothing while saves succeed must not say "Syncing…" after each one.
 */
const SYNC_QUIET_MS = 1000;

/** `active` once it has lasted `ms`: false again as soon as it ends. */
function useLasting(active: boolean, ms: number) {
  const [lasted, setLasted] = useState(false);
  useEffect(() => {
    if (!active) return;
    const timer = setTimeout(() => setLasted(true), ms);
    return () => {
      clearTimeout(timer);
      setLasted(false);
    };
  }, [active, ms]);
  return active && lasted;
}

type Window = { offline: boolean; lost: boolean; syncing: boolean };
const WindowState = createContext<Window>({ offline: false, lost: false, syncing: false });
/**
 * Times the window's states where it outlives every page (the layout): a note opened
 * while the connection is down does not restart the wait.
 */
export function WindowStatusProvider({ children }: { children: ReactNode }) {
  const { status, activity } = useConnection();
  // A working connection needs no word; "Connecting" is the first moment of every start.
  const offline = status !== "Connected" && status !== "Connecting";
  const lost = useLasting(offline, LOST_QUIET_MS);
  const syncing = useLasting(activity === "refresh", SYNC_QUIET_MS);
  return <WindowState value={{ offline, lost, syncing }}>{children}</WindowState>;
}

/** One message: its words, cut short before its buttons are. */
export function StatusMessage({
  fg,
  text,
  children,
}: {
  fg: string;
  text: string;
  children?: ReactNode;
}) {
  return (
    <box flexDirection="row" flexGrow={1} gap={1}>
      <text id="note-status" flexShrink={1} wrapMode="none" truncate fg={fg}>
        {text}
      </text>
      {children}
    </box>
  );
}

/** The line, saying the window's message or the page's, whichever comes first. */
export function StatusLine({
  id,
  page,
  warning = false,
}: {
  id: string;
  page: ReactNode;
  /** The page's message is a warning (a save in trouble), not a mere state. */
  warning?: boolean;
}) {
  const color = usePalette();
  const app = useApplication();
  const { status, activity, refresh } = useConnection();
  const { offline, lost, syncing } = useContext(WindowState);
  const message =
    lost || (offline && warning) ? (
      <StatusMessage
        fg={color.warn}
        // Whatever the page had to say is about text not yet on the Server.
        text={page ? `○ ${status}. Your text is kept here.` : `○ ${status}`}
      >
        <Button id="reconnect" tone="quiet" onPress={() => void refresh()}>
          Reconnect
        </Button>
      </StatusMessage>
    ) : page ? (
      page
    ) : activity === "navigate" ? (
      <StatusMessage fg={color.muted} text="Opening…">
        <Button tone="quiet" onPress={app.cancel}>
          Cancel
        </Button>
      </StatusMessage>
    ) : status === "Connecting" ? (
      <StatusMessage fg={color.muted} text="Connecting…" />
    ) : syncing ? (
      <StatusMessage fg={color.muted} text="Syncing…" />
    ) : null;
  return (
    <box id={id} flexDirection="row" height={1} flexShrink={0} gap={1}>
      {message}
    </box>
  );
}
