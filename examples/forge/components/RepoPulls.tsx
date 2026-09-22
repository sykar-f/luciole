"use client";
import { useKeyboard } from "@opentui/react";
import { useNavigate } from "@terminal/framework/client";
import { useEditing } from "./editing";
import { STATES, type StateFilter } from "./filters";
import { Line } from "./frames";
import type { PullSummary } from "./model";
import { PullList } from "./PullList";
import { color } from "./theme";

// The state filter lives in the URL (`?state=merged`) and is applied by the Server:
// back and forward restore it, and each filter is its own cached page. The text filter
// stays local, because typing must never wait for the network.
export function RepoPulls({
  repo,
  state,
  pulls,
}: {
  repo: string;
  state: StateFilter;
  pulls: PullSummary[];
}) {
  const navigate = useNavigate();
  const { editing } = useEditing();
  useKeyboard((key) => {
    if (editing || key.ctrl || key.name !== "s") return;
    const next = STATES[(STATES.indexOf(state) + 1) % STATES.length];
    void navigate({ to: "/repos/$repo", params: { repo }, search: { state: next } });
  });
  return (
    <box flexDirection="column" flexGrow={1} gap={1}>
      <Line id="state-filter" fg={color.muted}>
        {STATES.map((s) => (s === state ? `[${s}]` : ` ${s} `)).join(" ")}
      </Line>
      <PullList
        sections={[{ title: `${state} pull requests`, pulls }]}
        emptyText={`No ${state} pull request`}
        onCreate={() => void navigate({ to: "/repos/$repo/pulls/new", params: { repo } })}
      />
    </box>
  );
}
