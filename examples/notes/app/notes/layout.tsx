"use client";
import { useState } from "react";
import { useParams, type LayoutProps } from "airtty/client";

// Persistent while moving between notes: its local trail survives each navigation
// and resets only when the list is shown again.
export default function NotesLayout({ children }: LayoutProps) {
  const { id } = useParams({ strict: false });
  const [trail, setTrail] = useState<string[]>([]);
  // Adjust local state while rendering the new route parameter.
  if (id && trail.at(-1) !== id) setTrail([...trail, id]);
  return (
    <box flexDirection="column" gap={1} flexGrow={1}>
      <text id="notes-trail" height={1} flexShrink={0} wrapMode="none" truncate fg="#8b98a5">
        Opened this visit: {trail.join(" → ") || "…"}
      </text>
      {children}
    </box>
  );
}
