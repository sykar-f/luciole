"use client";
import { TransportError, type ErrorProps } from "@luciole-sh/core/client";
import { Screen } from "../components/frames";
import { Help } from "../components/Help";
import { color } from "../components/theme";

// Listing failed: the Server could not read the directory (permissions), or the request
// never completed. Ctrl+R (root layout) retries; Esc or back returns to the last listing.
export default function ListingError({ error }: ErrorProps) {
  const reason =
    error instanceof TransportError
      ? `${error.message} (${error.outcome})`
      : "The Server could not read this directory";
  return (
    <Screen title="Could not open this directory" help={<Help groups={["global"]} />}>
      <text fg={color.danger}>{reason}</text>
      <text fg={color.muted}>Ctrl+R to retry.</text>
    </Screen>
  );
}
