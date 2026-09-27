"use client";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { join } from "node:path";
import { TerminalView } from "airtty/client";
import { ClientFailure } from "airtty/dev";
import { spawnPty } from "airtty/pty";
import {
  buildChild,
  Capabilities,
  openSandbox,
  sandboxAvailability,
  sandboxRuntime,
  type Sandbox,
} from "airtty/sandbox";
import { color } from "@airtty/harness/ui/theme";
import type { PreviewInfo } from "./model";

export type PreviewProps = {
  preview: PreviewInfo;
  /** What the terminal is called: `r12`, or `draft`. */
  label: string;
  /** Whether the preview has the keys (everything but the host's prefix). */
  active: boolean;
  prefix: string;
  /** A page of the app failed: its path and why. */
  onFailure: (revision: number, path: string, message: string) => void;
  /** The app's Client ended (Ctrl+C in it, a crash). */
  onExit: (code: number | null) => void;
};

// The previous Client is waited for this long at most, then the next one starts anyway.
const EXIT_WAIT_MS = 3000;
const EXIT_POLL_MS = 10;

/** Whether `pid` still runs (a Client of the preview, a child of this process). */
function running(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
/** The last Client of the preview that was told to end, until it has. */
let leaving: Promise<void> = Promise.resolve();
/**
 * `pid` was told to end: the next Client waits for it. A Client writes its session as it
 * ends, and the next one takes over the newest session a dead Client left: started any
 * sooner, it would find the previous one alive and start with an empty session, losing
 * the page, the history, the typed text, the focus and the scroll positions.
 */
function ending(pid: number | undefined) {
  if (pid === undefined) return;
  const before = leaving;
  leaving = (async () => {
    await before;
    const deadline = performance.now() + EXIT_WAIT_MS;
    while (running(pid) && performance.now() < deadline) await Bun.sleep(EXIT_POLL_MS);
  })();
}

/**
 * The generated app, running: its Client on a PTY drawn by the VT widget, one per
 * revision or draft (a new one replaces it, once the previous Client has ended).
 * `sandbox`: under the OS sandbox, its bundle signed by the project's key and checked
 * against it (airtty/sandbox); `process`: with the user's rights, ended by SIGTERM
 * (<Terminal> would send SIGHUP).
 */
export function Preview(props: PreviewProps) {
  return props.preview.mode === "sandbox" ? (
    <SandboxPreview {...props} />
  ) : (
    <ProcessPreview {...props} />
  );
}

function useLatest(props: PreviewProps) {
  const latest = useRef(props);
  useLayoutEffect(() => {
    latest.current = props;
  });
  return latest;
}

function SandboxPreview(props: PreviewProps) {
  const { preview } = props;
  const [sandbox, setSandbox] = useState<Sandbox | undefined>();
  const [failure, setFailure] = useState("");
  const latest = useLatest(props);
  const { mechanism } = sandboxAvailability();
  // Each snapshot of the feed is a new object: the sandbox lives as long as what it runs.
  const program = `${preview.id} ${preview.url} ${preview.hosts.join(",")}`;
  const pid = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (!mechanism) return;
    const { preview } = latest.current;
    let opened: Sandbox | undefined;
    let closed = false;
    void Promise.all([leaving, buildChild()])
      .then(([, child]) =>
        openSandbox(
          {
            origin: `studio:${preview.project}`,
            url: preview.url,
            app: join(preview.output, "app"),
            fingerprint: preview.fingerprint,
            sessions: preview.sessions,
            granted: Capabilities.parse({ net: preview.hosts }),
            runtime: sandboxRuntime(),
            child,
            mechanism,
          },
          {
            // Clipboard, notifications, URLs: the preview is granted none of them.
            perform: () =>
              Promise.reject(new Error("studio's preview is granted no host capability")),
            onFailure: (f) => latest.current.onFailure(preview.revision, f.path, f.message),
          },
        ),
      )
      .then(
        (created) => {
          if (closed) return void created.close();
          opened = created;
          setSandbox(created);
        },
        (error: unknown) => setFailure(error instanceof Error ? error.message : String(error)),
      );
    return () => {
      closed = true;
      void opened?.close();
      ending(pid.current);
    };
  }, [program, latest, mechanism]);
  if (!mechanism) return <text fg={color.danger}>No sandbox on this system</text>;
  if (failure) return <text fg={color.danger}>{failure}</text>;
  if (!sandbox) return <text fg={color.muted}>Opening {props.label} in the sandbox…</text>;
  return (
    <TerminalView
      id="studio-preview-terminal"
      program={program}
      label={props.label}
      spawn={(io) => {
        const pty = sandbox.spawn(io);
        pid.current = pty.pid;
        return pty;
      }}
      active={props.active}
      prefix={props.prefix}
      onExit={(code) => latest.current.onExit(code)}
      flexGrow={1}
    />
  );
}

function ProcessPreview(props: PreviewProps) {
  const { preview } = props;
  const latest = useLatest(props);
  const [ready, setReady] = useState(false);
  const pid = useRef<number | undefined>(undefined);
  useEffect(() => {
    let mounted = true;
    void leaving.then(() => mounted && setReady(true));
    return () => {
      mounted = false;
      ending(pid.current);
    };
  }, []);
  if (!ready) return <text fg={color.muted}>Opening {props.label}…</text>;
  return (
    <TerminalView
      id="studio-preview-terminal"
      program={`${preview.id} ${preview.url}`}
      label={props.label}
      spawn={(io) => {
        const pty = spawnPty({
          ...io,
          command: [
            process.execPath,
            join(preview.output, "client/index.js"),
            "--url",
            preview.url,
          ],
          // The route and named fields pass from one revision's Client to the next.
          env: { AIRTTY_SESSION_KEY: `studio:${preview.project}` },
          ipc: (message) => {
            const failure = ClientFailure.safeParse(message);
            if (failure.success)
              latest.current.onFailure(preview.revision, failure.data.path, failure.data.message);
          },
        });
        pid.current = pty.pid;
        return {
          ...pty,
          kill: () => {
            try {
              process.kill(pty.pid, "SIGTERM");
            } catch {}
          },
        };
      }}
      active={props.active}
      prefix={props.prefix}
      onExit={(code) => latest.current.onExit(code)}
      flexGrow={1}
    />
  );
}
