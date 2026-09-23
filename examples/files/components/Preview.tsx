"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ImageRenderable, ScrollBoxRenderable } from "@opentui/core";
import { useRenderer, useTerminalDimensions } from "@opentui/react";
import { useApplication, useBindings } from "airtty/client";
import { thumbnail } from "../actions/files";
import { Line } from "./frames";
import type { Entry, ImageTarget, Preview, Thumbnail } from "./model";
import { next, PROTOCOLS, prefsStore, usePrefs } from "./prefs";
import { syntax } from "./syntax";
import { color } from "./theme";

// Shift+J/K scroll the pane by a few lines from the list; zoomed, the plain keys do.
const STEP_ROWS = 3,
  PAGE_ROWS = 20,
  HEX_ROW_BYTES = 16;

/**
 * The right-hand pane: highlighted text with line numbers, an image drawn by OpenTUI
 * (kitty graphics or truecolor half blocks), a directory's first entries or a hex dump.
 */
export function PreviewPane({
  entry,
  preview,
  zoomed,
  active,
}: {
  entry: Entry;
  preview: Preview;
  zoomed: boolean;
  active: boolean;
}) {
  const scroll = useRef<ScrollBoxRenderable>(null);
  const scrollable = preview.kind !== "image" && preview.kind !== "empty";
  const by = (rows: number) => scroll.current?.scrollBy(rows);
  const to = (top: number) => {
    if (scroll.current) scroll.current.scrollTop = top;
  };
  useBindings(
    () => ({
      bindings:
        !active || !scrollable
          ? []
          : [
              { key: "shift+j", cmd: () => by(STEP_ROWS), desc: "scroll", group: "preview" },
              { key: "shift+k", cmd: () => by(-STEP_ROWS) },
              ...(zoomed
                ? [
                    { key: "j", cmd: () => by(1) },
                    { key: "k", cmd: () => by(-1) },
                    { key: "down", cmd: () => by(1) },
                    { key: "up", cmd: () => by(-1) },
                    { key: "space", cmd: () => by(PAGE_ROWS), desc: "page", group: "preview" },
                    { key: "pagedown", cmd: () => by(PAGE_ROWS) },
                    { key: "pageup", cmd: () => by(-PAGE_ROWS) },
                    { key: "g", cmd: () => to(0) },
                    { key: "shift+g", cmd: () => to(Number.MAX_SAFE_INTEGER) },
                  ]
                : []),
            ],
    }),
    [active, scrollable, zoomed],
  );

  switch (preview.kind) {
    case "image":
      return <ImagePreview key={entry.path} path={entry.path} preview={preview} active={active} />;
    case "text":
      return (
        <box flexDirection="column" flexGrow={1}>
          <scrollbox id="preview-scroll" ref={scroll} flexGrow={1} scrollY scrollX>
            <line-number
              id="preview-lines"
              fg={color.faint}
              minWidth={4}
              paddingRight={1}
              flexShrink={0}
            >
              <code
                id="preview-code"
                content={preview.content}
                filetype={preview.language}
                syntaxStyle={syntax}
                conceal={false}
                wrapMode="none"
              />
            </line-number>
          </scrollbox>
          <Line id="preview-footer" fg={color.muted}>
            {preview.language === "text" ? "plain text" : preview.language} · {preview.lines} line
            {preview.lines === 1 ? "" : "s"}
            {preview.truncated ? " · head of the file only" : ""}
          </Line>
        </box>
      );
    case "directory":
      return (
        <box flexDirection="column" flexGrow={1}>
          <scrollbox id="preview-scroll" ref={scroll} flexGrow={1} scrollY>
            {preview.entries.length === 0 ? <Line fg={color.muted}>Empty directory</Line> : null}
            {preview.entries.map((child) => (
              <Line key={child.name} fg={child.kind === "directory" ? color.info : color.text}>
                {child.kind === "directory" ? "▸ " : "  "}
                {child.name}
                {child.kind === "directory" ? "/" : ""}
              </Line>
            ))}
          </scrollbox>
          <Line id="preview-footer" fg={color.muted}>
            {preview.total} entr{preview.total === 1 ? "y" : "ies"}
            {preview.total > preview.entries.length
              ? ` · first ${preview.entries.length} shown`
              : ""}{" "}
            · Enter opens
          </Line>
        </box>
      );
    case "binary":
      return (
        <box flexDirection="column" flexGrow={1}>
          <scrollbox id="preview-scroll" ref={scroll} flexGrow={1} scrollY>
            {preview.hex.map((row, i) => (
              <Line key={i} fg={color.muted}>
                {row}
              </Line>
            ))}
          </scrollbox>
          <Line id="preview-footer" fg={color.muted}>
            binary · first {preview.hex.length * HEX_ROW_BYTES} bytes
          </Line>
        </box>
      );
    case "empty":
      return <Line fg={color.muted}>Empty file</Line>;
    case "unavailable":
      return <Line fg={color.warn}>No preview · {preview.reason}</Line>;
  }
}

// Before a pane has been measured, and without the terminal's pixel size, assume a
// common cell of 10×20 pixels. Half blocks show 1×2 pixels per cell: ask for twice that,
// so that OpenTUI still downsamples.
const CELL_WIDTH = 10,
  CELL_HEIGHT = 20,
  BLOCK_OVERSAMPLE = 2,
  // A thumbnail within 10 % of the size the pane can show is kept.
  ENOUGH = 0.9;

/** The pixel size the last image pane could show: the next preview asks for it. */
export const imageTarget: { current: ImageTarget } = { current: { width: 640, height: 480 } };

function ImagePreview({
  path,
  preview,
  active,
}: {
  path: string;
  preview: Extract<Preview, { kind: "image" }>;
  active: boolean;
}) {
  const app = useApplication();
  const renderer = useRenderer();
  const terminal = useTerminalDimensions();
  const { protocol } = usePrefs();
  const view = useRef<ImageRenderable>(null);
  const [thumb, setThumb] = useState<Thumbnail>(preview.thumbnail);
  const [target, setTarget] = useState<ImageTarget | null>(null);
  const [drawn, setDrawn] = useState("");
  const [error, setError] = useState("");

  // The pane's size in pixels, for the protocol that draws it (kitty: real pixels).
  const measure = useCallback(() => {
    const image = view.current;
    if (!image || image.width <= 0 || image.height <= 0) return;
    const blocks = image.effectiveProtocol === "blocks";
    const cell = renderer.resolution
      ? {
          width: renderer.resolution.width / terminal.width,
          height: renderer.resolution.height / terminal.height,
        }
      : { width: CELL_WIDTH, height: CELL_HEIGHT };
    setDrawn(image.effectiveProtocol);
    setTarget(
      blocks
        ? { width: image.width * 2 * BLOCK_OVERSAMPLE, height: image.height * 2 * BLOCK_OVERSAMPLE }
        : {
            width: Math.round(image.width * cell.width),
            height: Math.round(image.height * cell.height),
          },
    );
  }, [renderer, terminal.width, terminal.height]);
  // `auto` resolves against the terminal's answers: measure again when it is forced.
  useEffect(measure, [measure, protocol]);

  // A pane larger than the thumbnail (zoom, bigger terminal, kitty) asks for a bigger
  // one; the current thumbnail stays on screen meanwhile, and a newer size cancels it.
  useEffect(() => {
    if (!target) return;
    imageTarget.current = target;
    const scale = Math.min(target.width / preview.width, target.height / preview.height, 1);
    if (thumb.width >= preview.width * scale * ENOUGH) return;
    const controller = new AbortController();
    app
      .withSignal(controller.signal, () => thumbnail(path, target))
      .then(
        (bigger) => {
          if (bigger && !controller.signal.aborted) setThumb(bigger);
        },
        () => {},
      );
    return () => controller.abort();
  }, [target, thumb, preview, path, app]);

  useBindings(
    () => ({
      bindings: active
        ? [
            {
              key: "p",
              cmd: () => prefsStore.update({ protocol: next(PROTOCOLS, protocol) }),
              desc: "image protocol",
              group: "preview",
            },
          ]
        : [],
    }),
    [active, protocol],
  );
  return (
    <box flexDirection="column" flexGrow={1}>
      {error ? <Line fg={color.danger}>Could not decode this image · {error}</Line> : null}
      <image
        id="preview-image"
        ref={view}
        source={thumb.data}
        protocol={protocol}
        fit="fit"
        flexGrow={1}
        onSizeChange={measure}
        onError={(e: unknown) => setError(e instanceof Error ? e.message : "unknown error")}
      />
      <Line id="preview-footer" fg={color.muted}>
        {preview.format.toUpperCase()} {preview.width}×{preview.height} · thumbnail {thumb.width}×
        {thumb.height} · drawn with {drawn === "blocks" ? "truecolor half blocks" : drawn || "…"}
        {protocol === "auto" ? " (auto)" : " (forced)"}
      </Line>
    </box>
  );
}
