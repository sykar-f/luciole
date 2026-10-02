"use client";
import { TransportError, type ErrorProps } from "@luciole-sh/core/client";
import { color } from "../components/theme";

// The page could not be loaded. The chrome's Ctrl+R retries.
export default function PageError({ error }: ErrorProps) {
  const reason =
    error instanceof TransportError && error.outcome === "not-sent"
      ? "Server unreachable"
      : error instanceof Error
        ? error.message
        : "Render failed";
  return (
    <text id="chat-error" height={1} wrapMode="none" truncate fg={color.warn}>
      {reason} · Ctrl+R to retry
    </text>
  );
}
