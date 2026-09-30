"use client";
import { TransportError, type ErrorProps } from "luciole/client";

// The page could not be loaded. Notes names the outcome; the chrome's Ctrl+R retries.
export default function PageError({ error }: ErrorProps) {
  const reason =
    error instanceof TransportError && error.outcome === "not-sent"
      ? "Server unreachable"
      : error instanceof Error
        ? error.message
        : "Render failed";
  return (
    <text id="note-error" height={1} wrapMode="none" truncate fg="#ffbc66">
      {reason} · Ctrl+R to retry
    </text>
  );
}
