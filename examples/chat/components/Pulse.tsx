"use client";
import { useEffect, useRef, type ReactNode } from "react";
import { useTimeline } from "@opentui/react";
import type { BoxRenderable } from "@opentui/core";

// Local loading animation: only opacity changes, geometry stays identical, and the
// timeline stops on unmount. No request depends on it.
const CYCLE_MS = 1700,
  DIMMEST = 0.25;
export function Pulse({ children }: { children: ReactNode }) {
  const target = useRef<BoxRenderable>(null);
  const timeline = useTimeline({ autoplay: false, duration: CYCLE_MS, loop: true });
  useEffect(() => {
    if (!target.current) return;
    timeline.add(target.current, {
      duration: CYCLE_MS / 2,
      ease: "inOutSine",
      opacity: DIMMEST,
      loop: true,
      alternate: true,
    });
    timeline.play();
    return () => {
      timeline.pause();
    };
  }, [timeline]);
  return (
    <box ref={target} flexDirection="column" flexGrow={1}>
      {children}
    </box>
  );
}
