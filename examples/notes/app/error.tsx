"use client";
import { TransportError, type ErrorProps } from "luciole/client";
import { EmptyPane } from "../components/NoteFrame";
import { usePalette } from "../components/theme";
import { Button, Line } from "../components/ui";

// The page could not be loaded: Notes says why, and offers to try again.
export default function PageError({ error, retry }: ErrorProps) {
  const color = usePalette();
  const reason =
    error instanceof TransportError && error.outcome === "not-sent"
      ? "Server unreachable"
      : error instanceof Error
        ? error.message
        : "Render failed";
  return (
    <EmptyPane id="note-error">
      <Line fg={color.warn}>{reason}</Line>
      <Button tone="primary" onPress={() => void retry()}>
        Try again
      </Button>
    </EmptyPane>
  );
}
