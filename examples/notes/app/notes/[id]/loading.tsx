"use client";
import { useEffect, useRef } from "react";
import type { BoxRenderable } from "@opentui/core";
import { useTimeline } from "@opentui/react";
import { KeyHelp, type LoadingProps } from "airtty/client";
import { NotePageFrame, NoteEditorFrame } from "../../../components/NoteFrame";

export default function Loading({ params }: LoadingProps) {
  const skeleton = useRef<BoxRenderable>(null);
  const timeline = useTimeline({ autoplay: false, duration: 1700, loop: true });
  useEffect(() => {
    if (!skeleton.current) return;
    timeline.add(skeleton.current, {
      duration: 850,
      ease: "inOutSine",
      opacity: 0.2,
      loop: true,
      alternate: true,
    });
    timeline.play();
    return () => {
      timeline.pause();
    };
  }, [timeline]);
  // The notebook and notes layouts stay mounted: only the page slot is replaced.
  return (
    <NotePageFrame title={`Opening note ${params.id}…`}>
      <NoteEditorFrame
        field={
          <box ref={skeleton}>
            <text id="note-placeholder" height={1} wrapMode="none" truncate fg="#d6d6d6">
              Loading note content…
            </text>
          </box>
        }
        status="Waiting for Server…"
        help={<KeyHelp inline groups={["airtty"]} />}
      />
    </NotePageFrame>
  );
}
