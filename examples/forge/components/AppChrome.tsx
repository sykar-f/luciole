"use client";
import { useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import { useApplication, useCanGoBack, useLocation, useNavigate, useRouter } from "airtty/client";
import { listRepos, logout, whoami } from "../actions/account";
import { onServerChange } from "./changes";
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
  useSyncExternalStore(app.drafts.subscribe, app.drafts.snapshot);
  useSyncExternalStore(operationStore.subscribe, operationStore.snapshot);
  const unsaved = app.drafts.unsaved();
  const unresolved = operationStore.unresolved();

  // Reads through Server Functions: no page render, no refresh.
  useEffect(() => {
    if (!sessionStore.get()) void whoami().then(sessionStore.set, () => {});
    const load = () => void listRepos().then(setRepos, () => {});
    load();
    return onServerChange(load);
  }, []);

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
    operationStore.clear();
    sessionStore.set(null);
    app.setToken(undefined);
  }

  useKeyboard((key) => {
    if (key.ctrl && key.name === "l") void signOut();
    if (editing || key.ctrl || key.meta) return;
    if (key.name === "i") void navigate({ to: "/" });
    if (key.name === "u" && canGoBack) router.history.back();
    if (key.sequence === "?") setHelp((shown) => !shown);
    const index = Number(key.sequence) - 1;
    if (Number.isInteger(index) && index >= 0 && repos[index])
      void navigate({ to: "/repos/$repo", params: { repo: repos[index].slug } });
  });

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
              Drafts {unsaved.length}/{app.drafts.capacity} unsaved
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
            {help ? <Keymap /> : <Line fg={color.faint}>? keys · Ctrl+L sign out</Line>}
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

function Keymap() {
  return (
    <box flexDirection="column" flexShrink={0}>
      {[
        "i inbox · 1-9 repos · u back",
        "Tab next tab (pull request)",
        "Esc stop editing / cancel",
        "Ctrl+S publish · Ctrl+X discard",
        "Ctrl+O resolve unknown",
        "Ctrl+R refresh · Ctrl+L out",
      ].map((line) => (
        <Line key={line} fg={color.muted}>
          {line}
        </Line>
      ))}
    </box>
  );
}
