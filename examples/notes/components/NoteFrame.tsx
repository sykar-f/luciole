import type { ReactNode } from "react";

// Pure presentation shared by the Server page and the local loading screen.
export function NotebookLayout({ children }: { children: ReactNode }) {
  return (
    <box flexDirection="column" gap={1} flexGrow={1}>
      <text id="notebook-heading" height={1} flexShrink={0} wrapMode="none" truncate fg="#8b98a5">
        Personal notebook · SQLite on Server
      </text>
      {children}
    </box>
  );
}

export function NotePageFrame({ title, children }: { title: ReactNode; children: ReactNode }) {
  return (
    <box flexDirection="column" gap={1} flexShrink={0}>
      <text id="note-heading" height={1} wrapMode="none" truncate fg="#67d9bc">
        {title}
      </text>
      {children}
    </box>
  );
}

export function NoteEditorFrame({
  field,
  status,
  conflict,
  error,
  help,
  dirty = false,
  statusColor,
}: {
  field: ReactNode;
  status: ReactNode;
  conflict?: ReactNode;
  error?: ReactNode;
  help: string;
  dirty?: boolean;
  statusColor?: string;
}) {
  return (
    <box flexDirection="column" gap={1} flexShrink={0}>
      <box id="note-field-frame" border borderColor="#526d82" padding={1} height={5} flexShrink={0}>
        {field}
      </box>
      <text
        id="note-status"
        height={1}
        wrapMode="none"
        truncate
        fg={statusColor ?? (dirty ? "#ffbc66" : "#67d9bc")}
      >
        {status}
      </text>
      <box id="note-feedback" height={2} flexDirection="column" flexShrink={0}>
        <text height={1} wrapMode="none" truncate fg="#ffbc66">
          {conflict ?? ""}
        </text>
        <text height={1} wrapMode="none" truncate fg="#ffbc66">
          {error ?? ""}
        </text>
      </box>
      <text id="note-help" height={1} wrapMode="none" truncate fg="#8b98a5">
        {help}
      </text>
    </box>
  );
}
