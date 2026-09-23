"use client";
import { useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { useTerminalDimensions } from "@opentui/react";
import {
  KeyHelp,
  useApplication,
  useBindings,
  useCanGoBack,
  useInvalidation,
  useLocation,
  useNavigate,
  useRouter,
} from "airtty/client";
import { listRepos, logout, whoami } from "../actions/account";
import { drafts } from "./draft";
import { EditingProvider } from "./editing";
import { Line } from "./frames";
import type { Repo } from "./model";
import { operationStore } from "./operations";
import { sessionStore, useIdentity } from "./session";
import { color } from "./theme";

const SIDEBAR = 30;
const WIDE = 110;

/** Human label of a Draft identity, for the unsaved-work panel. */
function label(id: string) {
  const parts = id.split(":");
  if (parts[0] === "pr") return `description of PR ${parts[1]}`;
  if (parts[1] === "conversation") return `comment on PR ${parts[2]}`;
  if (parts[1] === "line") return `${parts.slice(6).join(":").split("/").at(-1)}:${parts[5]}`;
  if (parts[1] === "new-pull") return `new PR in ${parts[2]}`;
  return id;
}

export function AppChrome({ children }: { children: ReactNode }) {
  const app = useApplication();
  const navigate = useNavigate();
  const router = useRouter();
  const canGoBack = useCanGoBack();
  const pathname = useLocation({ select: (l) => l.pathname });
  const identity = useIdentity();
  const { width } = useTerminalDimensions();
  const [editing, setEditing] = useState(false);
  const [repos, setRepos] = useState<Repo[]>([]);
  const [help, setHelp] = useState(false);
  const [confirmLogout, setConfirmLogout] = useState(false);
  useSyncExternalStore(drafts.subscribe, drafts.snapshot);
  useSyncExternalStore(operationStore.subscribe, operationStore.snapshot);
  const unsaved = drafts.unsaved();
  const unresolved = operationStore.unresolved();

  // Reads through Server Functions: no route loader refreshes them, an invalidation does.
  const loadRepos = () => void listRepos().then(setRepos, () => {});
  useEffect(() => {
    if (!sessionStore.get()) void whoami().then(sessionStore.set, () => {});
    loadRepos();
  }, []);
  useInvalidation(loadRepos);

  async function signOut() {
    if ((unsaved.length || unresolved.length) && !confirmLogout) {
      setConfirmLogout(true);
      return;
    }
    // Revoke on the Server when reachable; the local session ends regardless.
    await logout().catch(() => {});
    // Leave the private screens first: once unmounted, no component can re-create a
    // Draft from this identity's props after the bearer (and its Drafts) are dropped.
    await navigate({ to: "/login" });
    // Drafts and operations belong to the identity that made them.
    drafts.clear();
    operationStore.clear();
    sessionStore.set(null);
    app.setToken(undefined);
  }

  // Plain keys stay off while a field is being edited: they belong to the text.
  useBindings(
    () => ({
      bindings: [
        { key: "ctrl+l", cmd: () => void signOut(), desc: "sign out", group: "global" },
        ...(editing
          ? []
          : [
              { key: "i", cmd: () => void navigate({ to: "/" }), desc: "inbox", group: "app" },
              ...(canGoBack
                ? [{ key: "u", cmd: () => router.history.back(), desc: "back", group: "app" }]
                : []),
              { key: "?", cmd: () => setHelp((shown) => !shown), desc: "keys", group: "app" },
              ...repos.slice(0, 9).map((repo, i) => ({
                key: String(i + 1),
                cmd: () => void navigate({ to: "/repos/$repo", params: { repo: repo.slug } }),
                desc: repo.slug,
                group: "repos",
              })),
            ]),
      ],
    }),
    [editing, canGoBack, repos, navigate, router, signOut],
  );

  const sidebar = width >= WIDE;
  return (
    <EditingProvider value={{ editing, setEditing }}>
      <box flexDirection="row" flexGrow={1} gap={2}>
        {sidebar ? (
          <box
            id="sidebar"
            width={SIDEBAR}
            flexShrink={0}
            flexDirection="column"
            border
            borderColor={color.border}
            paddingX={1}
            title=" forge "
          >
            <Line id="sidebar-identity" fg={color.accent}>
              {identity ? `@${identity.id} · ${identity.role}` : "…"}
            </Line>
            <Line fg={color.muted}>{identity?.name}</Line>
            <Line />
            <Line fg={pathname === "/" ? color.accent : color.text}>[i] Inbox</Line>
            {repos.map((repo, i) => (
              <box
                key={repo.slug}
                onMouseDown={() =>
                  void navigate({ to: "/repos/$repo", params: { repo: repo.slug } })
                }
              >
                <Line fg={pathname.startsWith(`/repos/${repo.slug}`) ? color.accent : color.text}>
                  [{i + 1}] {repo.slug} ({repo.openPulls})
                </Line>
              </box>
            ))}
            <Line />
            <Line id="sidebar-drafts" fg={unsaved.length ? color.warn : color.muted}>
              Drafts {unsaved.length}/{drafts.capacity} unsaved
            </Line>
            {unsaved.slice(0, 6).map((draft) => (
              <Line key={draft.id} fg={draft.unknown ? color.danger : color.warn}>
                {draft.unknown ? " ? " : draft.pending ? " ↑ " : " • "}
                {label(draft.id)}
              </Line>
            ))}
            {unresolved.map((op) => (
              <Line key={op.operationId} fg={color.danger}>
                {" ? "}
                {op.label} unresolved
              </Line>
            ))}
            <box flexGrow={1} />
            {help ? (
              <KeyHelp />
            ) : (
              <KeyHelp inline groups={["app"]} fg={color.faint} accent={color.muted} />
            )}
          </box>
        ) : null}
        <box flexDirection="column" flexGrow={1}>
          {confirmLogout ? (
            <Line id="logout-confirm" fg={color.danger}>
              {unsaved.length} unsaved Draft(s), {unresolved.length} unresolved operation(s) will be
              lost · Ctrl+L again to sign out
            </Line>
          ) : null}
          {children}
        </box>
      </box>
    </EditingProvider>
  );
}
