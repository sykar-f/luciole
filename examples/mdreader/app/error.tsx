"use client";
import { TransportError, type ErrorProps } from "airtty/client";
import { Column, DocFrame, Line } from "../components/frames";
import { Help } from "../components/Help";
import { color } from "../components/theme";

// The document could not be loaded: the outcome says whether the Server was reached.
export default function DocError({ error, path }: ErrorProps) {
  const reason =
    error instanceof TransportError && error.outcome === "not-sent"
      ? "Server unreachable"
      : error instanceof Error
        ? error.message
        : "Render failed";
  return (
    <DocFrame
      title={path}
      subtitle="Could not load this document"
      help={<Help groups={["global"]} />}
    >
      <Column>
        <Line fg={color.warn}>{reason} · Ctrl+R to retry</Line>
      </Column>
    </DocFrame>
  );
}
