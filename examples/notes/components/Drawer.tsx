"use client";
import { useEffect, useEffectEvent, useState, type ReactNode } from "react";
import { createTimeline, engine } from "@opentui/core";

const SLIDE_MS = 160;

/**
 * A panel that slides open and shut from the left edge: its content keeps its full width
 * and is uncovered column by column. Shut, it narrows to a rail and shows `rail` instead:
 * the content is unmounted.
 */
export function Drawer({
  open,
  width,
  railWidth,
  rail,
  children,
}: {
  open: boolean;
  width: number;
  railWidth: number;
  rail: ReactNode;
  children: ReactNode;
}) {
  // The width while sliding, in cells; null at rest, where a resized terminal moves the
  // edge at once.
  const [sliding, setSliding] = useState<number | null>(null);
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    // Leaves from where it is: at rest, or midway through the last slide.
    if (sliding === null) setSliding(wasOpen ? width : railWidth);
  }
  const slide = useEffectEvent(() => {
    if (sliding === null) return;
    // A plain value is tweened, then rounded: a column is the smallest step drawn.
    const tween = { width: sliding };
    const timeline = createTimeline({ autoplay: false }).add(tween, {
      width: open ? width : railWidth,
      duration: SLIDE_MS,
      ease: "outQuad",
      onUpdate: () => setSliding(Math.round(tween.width)),
      onComplete: () => setSliding(null),
    });
    timeline.play();
    return () => {
      timeline.pause();
      engine.unregister(timeline);
    };
  });
  useEffect(() => slide(), [open]);
  const shut = !open && sliding === null;
  return (
    <box
      width={shut ? railWidth : (sliding ?? width)}
      flexShrink={0}
      flexDirection="row"
      overflow="hidden"
    >
      {shut ? rail : children}
    </box>
  );
}
