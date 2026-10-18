"use client";
import { createContext, useContext, useEffect, useId, useRef, type ReactNode } from "react";
import { useRenderer } from "@opentui/react";
import type { ProgramStatus as RendererStatus, ProgramStatusKind } from "@opentui/core";

export type ProgramStatusIdentity = { app: string; title: string };
/** Each state replaces the record. `clear` only addresses it; it carries no metadata. */
export type ProgramStatus =
  | { state: "idle" | "done" | "error"; id?: string; message?: string }
  | { state: "working"; id?: string; message?: string; progress?: number }
  | {
      state: "blocked";
      id?: string;
      kind: ProgramStatusKind;
      message: string;
      progress?: number;
    }
  | { state: "clear"; id?: string };

const Scope = createContext<string | undefined>(undefined);
const browser = () => "document" in globalThis;

/** Each inline Application gets its own terminal record subtree, even while unfocused. */
export function ProgramStatusScope({ children }: { children: ReactNode }) {
  const renderer = useRenderer();
  const parent = useContext(Scope);
  const key = useId().replace(/[^A-Za-z0-9_.+-]/g, "");
  const id = `${parent ? `${parent}/` : ""}pane-${key}`;
  useEffect(
    () => () => {
      if (!browser()) renderer.setProgramStatus({ state: "clear", id });
    },
    [renderer, id],
  );
  return <Scope value={id}>{children}</Scope>;
}

/** Reports committed state changes. Use `clear` to withdraw the addressed record. */
export function useProgramStatus(identity: ProgramStatusIdentity, status: ProgramStatus) {
  const renderer = useRenderer();
  const scope = useContext(Scope);
  const id = scope ? `${scope}${status.id ? `/${status.id}` : ""}` : status.id;
  const { app, title } = identity;
  const { state } = status;
  const message = "message" in status ? status.message : undefined;
  const kind = "kind" in status ? status.kind : undefined;
  const progress = "progress" in status ? status.progress : undefined;
  const latest = useRef<RendererStatus | null>(null);
  useEffect(() => {
    if (browser()) return;
    const report: RendererStatus =
      state === "clear"
        ? { state: "clear", ...(id === undefined ? {} : { id }) }
        : {
            state,
            app,
            title,
            ...(id === undefined ? {} : { id }),
            ...(message === undefined ? {} : { message }),
            ...(kind === undefined ? {} : { kind }),
            ...(progress === undefined ? {} : { progress }),
          };
    renderer.setProgramStatus(report);
    latest.current = report;
  }, [renderer, app, title, id, state, message, kind, progress]);
  useEffect(
    () => () => {
      const state = latest.current?.state;
      if (!browser() && state && (scope || state === "working" || state === "blocked"))
        renderer.setProgramStatus({ state: "clear", ...(id === undefined ? {} : { id }) });
      latest.current = null;
    },
    [renderer, scope, id],
  );
}
