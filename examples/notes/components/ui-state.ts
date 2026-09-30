"use client";
import { useSyncExternalStore } from "react";

// State of the notebook's chrome, above the routes: it survives every navigation, and
// never reaches the Server.

export type MenuItem = { label: string; danger?: boolean; run: () => void };
export type Menu = { items: readonly MenuItem[]; x: number; y: number };
/** Where typing goes: the search box, the note's title or its text, or nowhere. */
export type Focus = "search" | "title" | "body" | null;
export type Toast = { text: string; action?: { label: string; run: () => void } };
type State = {
  sidebar: boolean;
  menu: Menu | null;
  toast: Toast | null;
  /** A note whose title should open for renaming once it is shown. */
  renaming: string | null;
  focus: Focus;
};

const TOAST_MS = 6000;
let state: State = { sidebar: true, menu: null, toast: null, renaming: null, focus: null };
let toastTimer: ReturnType<typeof setTimeout> | undefined;
const listeners = new Set<() => void>();
function update(patch: Partial<State>) {
  state = { ...state, ...patch };
  for (const listener of listeners) listener();
}

export const ui = {
  get: () => state,
  subscribe: (listener: () => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
  toggleSidebar: () => update({ sidebar: !state.sidebar }),
  openMenu: (menu: Menu) => update({ menu }),
  closeMenu: () => update({ menu: null }),
  /** Shown for a few seconds, or until the next one. */
  toast: (toast: Toast) => {
    clearTimeout(toastTimer);
    update({ toast });
    toastTimer = setTimeout(() => update({ toast: null }), TOAST_MS);
  },
  dismissToast: () => {
    clearTimeout(toastTimer);
    update({ toast: null });
  },
  rename: (id: string | null) => update({ renaming: id }),
  focus: (focus: Focus) => {
    if (focus !== state.focus) update({ focus });
  },
};

export const useUi = () => useSyncExternalStore(ui.subscribe, ui.get);
