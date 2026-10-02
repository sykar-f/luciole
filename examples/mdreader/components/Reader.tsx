"use client";
import { useEffect, useRef, useState } from "react";
import type { MarkdownRenderable, ScrollBoxRenderable } from "@opentui/core";
import { useBindings } from "@luciole-sh/core/client";
import { DocFrame, Line, READING_WIDTH } from "./frames";
import { Help } from "./Help";
import { useMode } from "./Library";
import type { Doc } from "./model";
import { codeBlocks, locateHeadings, type Heading } from "./rendering";
import { syntax } from "./syntax";
import { bytes, color } from "./theme";

const OUTLINE_WIDTH = 34;
// Scroll metrics are sampled locally: the wheel, a resize or the highlighter can move
// the content without a key press. No request depends on it.
const SAMPLE_MS = 150;
const PERCENT = 100;

// Where each document was left, for this Client's lifetime: coming back resumes there.
const positions = new Map<string, number>();

type Outline = { index: number; origin: number };
type View = { top: number; height: number; total: number };
const sameView = (a: View, b: View) =>
  a.top === b.top && a.height === b.height && a.total === b.total;

/** `Top`, `Bot`, `All` or a percentage, like a pager. */
function position({ top, height, total }: View) {
  if (total <= height) return "All";
  if (top <= 0) return "Top";
  if (top >= total - height) return "Bot";
  return `${Math.round((top / (total - height)) * PERCENT)}%`;
}

/**
 * One document, rendered by OpenTUI's `<markdown>`: headings, emphasis, lists, quotes,
 * tables, links and highlighted code blocks. Scrolling and the outline are local; the
 * page re-renders this component (same key) when the file changes, so the reading
 * position survives a reload.
 */
export function Reader({ doc }: { doc: Doc }) {
  const { mode, setMode } = useMode();
  const scroll = useRef<ScrollBoxRenderable>(null);
  const markdown = useRef<MarkdownRenderable>(null);
  const [view, setView] = useState<View>({ top: 0, height: 0, total: 0 });
  const [headings, setHeadings] = useState<Heading[]>([]);
  const [outline, setOutline] = useState<Outline | null>(null);
  // Keys can arrive faster than renders (`jjj` in one read): handlers read the latest
  // outline here, never the one captured by the last render.
  const outlineNow = useRef<Outline | null>(null);
  const restore = useRef(positions.get(doc.path) ?? 0);
  const layout = useRef("");
  const outlineList = useRef<ScrollBoxRenderable>(null);

  const measure = () => {
    const box = scroll.current;
    const md = markdown.current;
    if (!box || !md) return;
    const next = { top: box.scrollTop, height: box.viewport.height, total: box.scrollHeight };
    // The saved position applies once the document is laid out tall enough.
    if (restore.current && next.total > next.height) {
      box.scrollTop = restore.current;
      restore.current = 0;
      next.top = box.scrollTop;
    }
    setView((v) => (sameView(v, next) ? v : next));
    // Headings move only when the layout does (width, wrapping, highlighting).
    const shape = `${next.total}:${box.width}`;
    if (shape !== layout.current) {
      layout.current = shape;
      setHeadings(locateHeadings(md, box.content.y));
    }
  };
  useEffect(() => {
    const timer = setInterval(measure, SAMPLE_MS);
    return () => clearInterval(timer);
  });
  useEffect(
    () => () => {
      if (scroll.current) positions.set(doc.path, scroll.current.scrollTop);
    },
    [doc.path],
  );
  // The outline belongs to this document: leaving it returns the keys to the reader. A
  // list being browsed keeps them.
  useEffect(() => () => setMode((m) => (m === "outline" ? "doc" : m)), [setMode]);

  const scrollTo = (top: number) => {
    const box = scroll.current;
    if (!box) return;
    box.scrollTop = Math.max(0, top);
    measure();
  };
  const top = () => scroll.current?.scrollTop ?? 0;
  const bottom = () => scroll.current?.scrollHeight ?? 0;
  const by = (rows: number) => scrollTo(top() + rows);
  const page = Math.max(1, view.height - 2);
  // Positions as laid out right now (the sampled ones may lag a resize by a tick).
  const locate = () =>
    markdown.current && scroll.current
      ? locateHeadings(markdown.current, scroll.current.content.y)
      : headings;
  // The section being read: the last heading at or above the top row.
  const section = headings.findLastIndex((h) => h.top <= view.top);
  const jump = (delta: number) => {
    const found = locate();
    const target =
      delta > 0 ? found.find((h) => h.top > top()) : found.findLast((h) => h.top < top());
    if (target) scrollTo(target.top);
  };

  const showOutline = (next: Outline | null) => {
    outlineNow.current = next;
    setOutline(next);
    setMode(next ? "outline" : "doc");
  };
  const openOutline = () => {
    const found = locate();
    setHeadings(found);
    const index = Math.max(
      0,
      found.findLastIndex((h) => h.top <= top()),
    );
    showOutline({ index, origin: top() });
  };
  const closeOutline = ({ keep }: { keep: boolean }) => {
    if (!keep && outlineNow.current) scrollTo(outlineNow.current.origin);
    showOutline(null);
  };
  const select = (index: number) => {
    const current = outlineNow.current;
    if (!current) return;
    const found = locate();
    const target = Math.max(0, Math.min(index, found.length - 1));
    showOutline({ ...current, index: target });
    if (found[target]) scrollTo(found[target].top);
  };
  const selectBy = (delta: number) => select((outlineNow.current?.index ?? 0) + delta);

  useEffect(() => {
    if (outline) outlineList.current?.scrollChildIntoView(`outline-${outline.index}`);
  }, [outline]);

  useBindings(
    () => ({
      bindings:
        mode === "outline" && outline
          ? [
              { key: "j", cmd: () => selectBy(1), desc: "next", group: "outline" },
              {
                key: "k",
                cmd: () => selectBy(-1),
                desc: "previous",
                group: "outline",
              },
              { key: "down", cmd: () => selectBy(1) },
              { key: "up", cmd: () => selectBy(-1) },
              { key: "g", cmd: () => select(0) },
              { key: "shift+g", cmd: () => select(Number.MAX_SAFE_INTEGER) },
              {
                key: "return",
                cmd: () => closeOutline({ keep: true }),
                desc: "read here",
                group: "outline",
              },
              { key: "t", cmd: () => closeOutline({ keep: true }) },
              {
                key: "escape",
                cmd: () => closeOutline({ keep: false }),
                desc: "back",
                group: "outline",
              },
            ]
          : mode === "doc"
            ? [
                { key: "j", cmd: () => by(1), desc: "down", group: "doc" },
                { key: "k", cmd: () => by(-1), desc: "up", group: "doc" },
                { key: "down", cmd: () => by(1) },
                { key: "up", cmd: () => by(-1) },
                { key: "space", cmd: () => by(page), desc: "page", group: "doc" },
                { key: "pagedown", cmd: () => by(page) },
                { key: "b", cmd: () => by(-page), desc: "page up", group: "doc" },
                { key: "pageup", cmd: () => by(-page) },
                { key: "d", cmd: () => by(Math.ceil(page / 2)) },
                { key: "ctrl+d", cmd: () => by(Math.ceil(page / 2)) },
                { key: "ctrl+u", cmd: () => by(-Math.ceil(page / 2)) },
                { key: "g", cmd: () => scrollTo(0), desc: "top", group: "doc" },
                { key: "home", cmd: () => scrollTo(0) },
                { key: "shift+g", cmd: () => scrollTo(bottom()), desc: "end", group: "doc" },
                { key: "end", cmd: () => scrollTo(bottom()) },
                { key: "}", cmd: () => jump(1), desc: "next heading", group: "doc" },
                { key: "{", cmd: () => jump(-1) },
                { key: "t", cmd: openOutline, desc: "outline", group: "doc" },
              ]
            : [],
    }),
    [mode, outline, headings, view, page],
  );

  const modified = new Date(doc.modified).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
  return (
    <DocFrame
      title={doc.path}
      subtitle={`${doc.lines} lines · ${bytes(doc.size)} · modified ${modified}${doc.truncated ? " · only the first 2 MB are shown" : ""}`}
      status={
        <>
          <text id="doc-section" flexGrow={1} wrapMode="none" truncate fg={color.muted}>
            {section >= 0 ? `§ ${headings[section].text}` : ""}
          </text>
          <text id="doc-position" flexShrink={0} wrapMode="none" fg={color.muted}>
            {headings.length
              ? `${headings.length} heading${headings.length === 1 ? "" : "s"} · `
              : ""}
            {position(view)}
          </text>
        </>
      }
      help={<Help groups={mode === "outline" ? ["outline"] : ["doc"]} />}
    >
      <scrollbox
        id="doc-scroll"
        ref={scroll}
        flexGrow={1}
        scrollY
        onMouseScroll={() => setTimeout(measure, 0)}
        // A click in the document gives it the keys, like a click in a pane.
        onMouseDown={() => setMode((m) => (m === "list" ? "doc" : m))}
      >
        {doc.content.trim() ? (
          <markdown
            id="doc-markdown"
            ref={markdown}
            content={doc.content}
            syntaxStyle={syntax}
            conceal
            renderNode={codeBlocks}
            tableOptions={{ widthMode: "content", wrapMode: "word", borderColor: color.border }}
            // A centered reading column, as on the web; the right padding keeps tables
            // clear of the scrollbar.
            width="100%"
            maxWidth={READING_WIDTH}
            alignSelf="center"
            paddingRight={2}
            flexShrink={0}
          />
        ) : (
          <Line fg={color.muted}>This document is empty.</Line>
        )}
      </scrollbox>
      {outline ? (
        <box
          id="outline"
          // Over the document rather than beside it: the text keeps its wrapping, so the
          // heading rows the outline scrolls to stay exact.
          position="absolute"
          top={0}
          right={0}
          bottom={0}
          zIndex={10}
          width={OUTLINE_WIDTH}
          backgroundColor={color.panel}
          flexDirection="column"
          border
          borderColor={color.accentDim}
          paddingX={1}
          title=" outline "
        >
          <scrollbox id="outline-list" ref={outlineList} flexGrow={1} scrollY>
            {headings.length ? null : <Line fg={color.muted}>No heading</Line>}
            {headings.map((heading, i) => (
              <box
                key={`${i}:${heading.text}`}
                id={`outline-${i}`}
                height={1}
                flexShrink={0}
                paddingLeft={(heading.level - 1) * 2}
                backgroundColor={i === outline.index ? color.selected : undefined}
                onMouseDown={() => select(i)}
              >
                <Line
                  fg={
                    i === outline.index
                      ? color.accent
                      : heading.level <= 2
                        ? color.text
                        : color.muted
                  }
                >
                  {heading.text || "(untitled)"}
                </Line>
              </box>
            ))}
          </scrollbox>
        </box>
      ) : null}
    </DocFrame>
  );
}
