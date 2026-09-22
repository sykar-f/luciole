"use client";
import { useState, type ReactNode } from "react";
import { useParams } from "airtty/client";
import { Line } from "./frames";
import { color } from "./theme";

// Persistent while moving between pull requests of one repository: the trail of
// visited pull requests is local state that survives each navigation.
export function RepoChrome({ repo, children }: { repo: string; children: ReactNode }) {
  const { number } = useParams({ strict: false });
  const [trail, setTrail] = useState<string[]>([]);
  if (number && trail.at(-1) !== number)
    setTrail([...trail.filter((n) => n !== number), number].slice(-6));
  return (
    <box flexDirection="column" flexGrow={1}>
      <Line id="repo-heading" fg={color.muted}>
        acme / <span fg={color.accent}>{repo}</span>
        {trail.length ? `  ·  visited ${trail.map((n) => `#${n}`).join(" → ")}` : ""}
      </Line>
      {children}
    </box>
  );
}
