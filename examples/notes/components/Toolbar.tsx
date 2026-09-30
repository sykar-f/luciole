"use client";
import { createContext, useContext, type ReactNode } from "react";
import type { BoxRenderable } from "@opentui/core";
import { createPortal } from "@opentui/react";
import { usePalette } from "./theme";

// The window's toolbar belongs to the layout, but some of its buttons belong to the page
// on screen: the page sends them into the toolbar's slot, and takes them away on leaving.

const ActionsSlot = createContext<BoxRenderable | null>(null);
export const ActionsSlotProvider = ActionsSlot.Provider;

/** A thin rule between two groups of buttons. */
export function Separator() {
  const color = usePalette();
  return (
    <text flexShrink={0} fg={color.faint}>
      │
    </text>
  );
}

/** The page's own buttons, shown in the toolbar after the window's. */
export function ToolbarActions({ children }: { children: ReactNode }) {
  const slot = useContext(ActionsSlot);
  if (!slot) return null;
  return (
    <>
      {createPortal(
        <>
          <Separator />
          {children}
        </>,
        slot,
        null,
      )}
    </>
  );
}
