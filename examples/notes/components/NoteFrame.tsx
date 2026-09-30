import type { ReactNode } from "react";

// Pure presentation shared by the note and its loading screen: both use the same frame,
// so nothing moves when the Server answers.

/** The widest a note's text runs, as on a printed page. */
export const READING_WIDTH = 88;
// Left of the text, where heading bands and code panels start: the title lines up with the
// text, not with them.
const PAGE_MARGIN = 2;

/**
 * The right side: the page, with its status line, its title, then the note itself. The
 * status line is empty most of the time, and always there: what it says moves nothing.
 */
export function NotePane({
  status,
  title,
  children,
}: {
  status: ReactNode;
  title: ReactNode;
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
        <box
          id="note-status-line"
          flexDirection="row"
          height={1}
          flexShrink={0}
          gap={1}
          paddingLeft={PAGE_MARGIN}
        >
          {status}
        </box>
        <box
          id="note-heading"
          flexDirection="column"
          flexShrink={0}
          marginTop={1}
          marginBottom={1}
          paddingLeft={PAGE_MARGIN}
        >
          {title}
        </box>
        <box id="note-body" flexDirection="column" flexGrow={1}>
          {children}
        </box>
      </box>
    </box>
  );
}
