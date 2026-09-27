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
  /** Whether the preview has the keys (everything but the host's prefix). */
  active: boolean;
  prefix: string;
  /** A page of the app failed: its path and why. */
  onFailure: (revision: number, path: string, message: string) => void;
  /** The app's Client ended (Ctrl+C in it, a crash). */
  onExit: (code: number | null) => void;
};

/**
 * The generated app, running: its Client on a PTY drawn by the VT widget, one per
 * revision (a new revision replaces it). `sandbox`: under the OS sandbox, its bundle
 * signed by the project's key and checked against it (airtty/sandbox); `process`: with
 * the user's rights, ended by SIGTERM (<Terminal> would send SIGHUP).
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
  const program = `r${preview.revision} ${preview.url} ${preview.hosts.join(",")}`;
  useEffect(() => {
    if (!mechanism) return;
    const { preview } = latest.current;
    let opened: Sandbox | undefined;
    let closed = false;
    void buildChild()
      .then((child) =>
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
    };
  }, [program, latest, mechanism]);
  if (!mechanism) return <text fg={color.danger}>No sandbox on this system</text>;
  if (failure) return <text fg={color.danger}>{failure}</text>;
  if (!sandbox) return <text fg={color.muted}>Opening r{preview.revision} in the sandbox…</text>;
  return (
    <TerminalView
      id="studio-preview-terminal"
      program={program}
      label={`r${preview.revision}`}
      spawn={(io) => sandbox.spawn(io)}
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
  return (
    <TerminalView
      id="studio-preview-terminal"
      program={`r${preview.revision} ${preview.url}`}
      label={`r${preview.revision}`}
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
