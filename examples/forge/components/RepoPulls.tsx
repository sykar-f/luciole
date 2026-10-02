"use client";
import { useCallback } from "react";
import { useBindings, useNavigate } from "@luciole-sh/core/client";
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
  const next = STATES[(STATES.indexOf(state) + 1) % STATES.length];
  useBindings(
    () => ({
      bindings: editing
        ? []
        : [
            {
              key: "s",
              cmd: () =>
                void navigate({ to: "/repos/$repo", params: { repo }, search: { state: next } }),
              desc: `show ${next}`,
              group: "repo",
            },
          ],
    }),
    [editing, repo, next, navigate],
  );
  // Stable across renders: the list's key layer depends on it.
  const create = useCallback(
    () => void navigate({ to: "/repos/$repo/pulls/new", params: { repo } }),
    [navigate, repo],
  );
  return (
    <box flexDirection="column" flexGrow={1} gap={1}>
      <Line id="state-filter" fg={color.muted}>
        {STATES.map((s) => (s === state ? `[${s}]` : ` ${s} `)).join(" ")}
      </Line>
      <PullList
        sections={[{ title: `${state} pull requests`, pulls }]}
        emptyText={`No ${state} pull request`}
        onCreate={create}
      />
    </box>
  );
}
