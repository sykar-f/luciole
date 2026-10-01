import type { ReactNode } from "react";
import { StatusLine } from "./StatusLine";

// The frame shared by the note, its loading screen and the empty page: all use the same
// one, so nothing moves when the Server answers.

/** The widest a note's text runs, as on a printed page. */
export const READING_WIDTH = 88;
// Left of the text, where heading bands and code panels start: the title lines up with the
// text, not with them.
const PAGE_MARGIN = 2;

/**
 * The right side: the page, with its status line, its title and the note's menu, then the
 * note itself. The status line is empty most of the time, and always there: what it says
 * moves nothing. It speaks for the window too (components/StatusLine.tsx).
 */
export function NotePane({
  status,
  warning,
  title,
  menu,
  children,
}: {
  status: ReactNode;
  /** `status` is a warning: a lost connection speaks over it at once. */
  warning?: boolean;
  title: ReactNode;
  /** The note's "⋯", at the far end of its title. */
  menu?: ReactNode;
  children: ReactNode;
}) {
  return (
    <box id="note-pane" flexDirection="column" flexGrow={1} paddingX={2} paddingTop={1}>
      {/* The page: its status, title and text centered together, as wide as the text runs. */}
      <box
        id="note-page"
        flexDirection="column"
        flexGrow={1}
        width="100%"
        maxWidth={READING_WIDTH + PAGE_MARGIN * 2}
        alignSelf="center"
      >
        <box paddingLeft={PAGE_MARGIN} flexShrink={0}>
          <StatusLine id="note-status-line" page={status} warning={warning} />
        </box>
        <box
          id="note-heading"
          flexDirection="row"
          flexShrink={0}
          gap={1}
          marginTop={1}
          marginBottom={1}
          paddingLeft={PAGE_MARGIN}
        >
          <box flexDirection="column" flexGrow={1} flexShrink={1}>
            {title}
          </box>
          {menu}
        </box>
        <box id="note-body" flexDirection="column" flexGrow={1}>
          {children}
        </box>
      </box>
    </box>
  );
}

/** The right side with no note: the same status line, then what to do, centered. */
export function EmptyPane({ id, children }: { id: string; children: ReactNode }) {
  return (
    <box id={id} flexDirection="column" flexGrow={1} paddingX={2} paddingTop={1}>
      <box
        flexDirection="column"
        width="100%"
        maxWidth={READING_WIDTH + PAGE_MARGIN * 2}
        alignSelf="center"
        paddingLeft={PAGE_MARGIN}
      >
        <StatusLine id={`${id}-status-line`} page={null} />
      </box>
      <box flexDirection="column" flexGrow={1} alignItems="center" justifyContent="center" gap={1}>
        {children}
      </box>
    </box>
  );
}
