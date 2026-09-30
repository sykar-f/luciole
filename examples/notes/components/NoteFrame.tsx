import type { ReactNode } from "react";

// Pure presentation shared by the note and its loading screen: both use the same frame,
// so nothing moves when the Server answers.

/** The right side: a toolbar row, the title, an optional notice, then the note itself. */
export function NotePane({
  toolbar,
  title,
  notice,
  children,
}: {
  toolbar: ReactNode;
  title: ReactNode;
  notice?: ReactNode;
  children: ReactNode;
}) {
  return (
    <box id="note-pane" flexDirection="column" flexGrow={1} paddingX={2} paddingTop={1}>
      <box id="note-toolbar" flexDirection="row" height={1} flexShrink={0} gap={1}>
        {toolbar}
      </box>
      <box id="note-heading" flexDirection="column" flexShrink={0} marginTop={1} marginBottom={1}>
        {title}
        {notice}
      </box>
      <box id="note-body" flexDirection="column" flexGrow={1}>
        {children}
      </box>
    </box>
  );
}
