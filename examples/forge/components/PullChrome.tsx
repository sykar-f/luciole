"use client";
import type { ReactNode } from "react";
import { KeyHelp, useBindings, useMatchRoute, useNavigate } from "@luciole-sh/core/client";
import { useEditing } from "./editing";
import { Line } from "./frames";
import { ReviewSessionProvider } from "./review-session";
import { color } from "./theme";

const TABS = [
  { label: "Conversation", to: "/repos/$repo/pulls/$number" },
  { label: "Files", to: "/repos/$repo/pulls/$number/files" },
  { label: "Checks", to: "/repos/$repo/pulls/$number/checks" },
] as const;

// Persistent across the three tabs of one pull request. The tab bar is local: the
// active tab comes from TanStack's route matching, switching is a typed navigation.
export function PullChrome({
  repo,
  number,
  children,
}: {
  repo: string;
  number: string;
  children: ReactNode;
}) {
  const navigate = useNavigate();
  const matchRoute = useMatchRoute();
  const { editing } = useEditing();
  const params = { repo, number };
  // During a tab switch the pending destination is highlighted at once.
  const active = Math.max(
    0,
    TABS.findIndex(
      (tab) =>
        matchRoute({ to: tab.to, params, pending: true }) !== false ||
        matchRoute({ to: tab.to, params }) !== false,
    ),
  );
  const go = (index: number) =>
    void navigate({ to: TABS[(index + TABS.length) % TABS.length].to, params });
  // Tab belongs to a field while one is edited (the new pull request form uses it too).
  useBindings(
    () => ({
      bindings: editing
        ? []
        : [
            { key: "tab", cmd: () => go(active + 1), desc: "next tab", group: "pull" },
            { key: "shift+tab", cmd: () => go(active - 1), desc: "previous", group: "pull" },
          ],
    }),
    [editing, active, repo, number, navigate],
  );
  return (
    <ReviewSessionProvider key={`${repo}#${number}`}>
      <box flexDirection="column" flexGrow={1}>
        <box id="pull-tabs" flexDirection="row" height={1} flexShrink={0} gap={2}>
          <Line fg={color.muted}>#{number}</Line>
          {TABS.map((tab, index) => (
            <box key={tab.label} onMouseDown={() => go(index)}>
              <Line
                fg={index === active ? color.accent : color.muted}
                bg={index === active ? color.selected : undefined}
              >
                {` ${tab.label} `}
              </Line>
            </box>
          ))}
          <KeyHelp inline groups={["pull"]} fg={color.faint} accent={color.muted} />
        </box>
        {children}
      </box>
    </ReviewSessionProvider>
  );
}
