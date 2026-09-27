/** @jsxImportSource @opentui/react */
import { memo, useEffect, useMemo, useState } from "react";
import {
  type BoxRenderable,
  infoStringToFiletype,
  type OptimizedBuffer,
  RGBA,
  StyledText,
  type SyntaxStyle,
} from "@opentui/core";
import { useRenderer } from "@opentui/react";
import { type Node, Palette } from "./render";
import { MarkdownStream } from "./stream";

export type MarkdownProps = {
  content: string;
  /** Whether `content` is still being written: its last block is then closed optimistically. */
  streaming: boolean;
  syntaxStyle: SyntaxStyle;
};

/**
 * Markdown that holds still while it streams: finished blocks are drawn once, the block
 * being written is drawn synchronously with its open markers closed, and the finished
 * reply looks like the streamed one. OpenTUI's `<markdown>` redraws its last block from a
 * preview at each change, then again once Tree-sitter answers: the two differ, and the
 * reply flashes between raw and formatted text at every delta.
 */
export function Markdown({ content, streaming, syntaxStyle }: MarkdownProps) {
  const hyperlinks = useHyperlinks();
  const background = useTerminalBackground();
  const stream = useMemo(
    () => new MarkdownStream(new Palette(syntaxStyle, { hyperlinks })),
    [syntaxStyle, hyperlinks],
  );
  const look = useMemo(
    () => ({ palette: stream.palette, syntaxStyle, background }),
    [stream, syntaxStyle, background],
  );
  const blocks = stream.update(content, streaming);
  return (
    <box flexDirection="column" flexShrink={0}>
      {blocks.map((block) => (
        <BlockView key={block.key} nodes={block.nodes} marginTop={block.marginTop} look={look} />
      ))}
    </box>
  );
}

// How long the terminal has to report its colors (OSC 11) before bands fade in alpha.
const PALETTE_TIMEOUT_MS = 1000;

/**
 * The terminal's default background, asked once (OpenTUI caches it) and again when the
 * terminal switches theme; undefined until it answers, or if it never does.
 */
function useTerminalBackground() {
  const renderer = useRenderer();
  const [background, setBackground] = useState<RGBA | undefined>(undefined);
  useEffect(() => {
    let live = true;
    const ask = () => {
      renderer
        .getPalette({ timeout: PALETTE_TIMEOUT_MS })
        .then((colors) => {
          // A terminal that does not report its background (null) keeps the alpha fade.
          if (live && colors.defaultBackground)
            setBackground(RGBA.fromHex(colors.defaultBackground));
        })
        .catch(() => undefined);
    };
    ask();
    renderer.on("theme_mode", ask);
    return () => {
      live = false;
      renderer.off("theme_mode", ask);
    };
  }, [renderer]);
  return background;
}

/** Whether the terminal draws OSC 8 hyperlinks: links then show their label alone. */
function useHyperlinks() {
  const renderer = useRenderer();
  const [hyperlinks, setHyperlinks] = useState(renderer.capabilities?.hyperlinks === true);
  useEffect(() => {
    const update = () => setHyperlinks(renderer.capabilities?.hyperlinks === true);
    update();
    renderer.on("capabilities", update);
    return () => {
      renderer.off("capabilities", update);
    };
  }, [renderer]);
  return hyperlinks;
}

/** How blocks are drawn: the same for every block of a reply. */
type Look = {
  palette: Palette;
  syntaxStyle: SyntaxStyle;
  /** The terminal's default background, when it reported it. */
  background: RGBA | undefined;
};
type BlockProps = { nodes: readonly Node[]; marginTop: number; look: Look };

/** One block: redrawn only when its nodes change, which finished blocks never do. */
const BlockView = memo(function BlockView({ nodes, marginTop, look }: BlockProps) {
  return (
    <box flexDirection="column" flexShrink={0} marginTop={marginTop}>
      {nodes.map((node, i) => (
        <NodeView key={i} node={node} look={look} />
      ))}
    </box>
  );
});

function NodeView({ node, look }: { node: Node; look: Look }) {
  const { palette, syntaxStyle } = look;
  const layout = { marginTop: node.marginTop, marginLeft: node.indent, flexShrink: 0 };
  switch (node.kind) {
    case "text":
      return <TextView chunks={node.chunks} marginTop={node.marginTop} />;
    case "code":
      return (
        <box {...layout}>
          {node.closed ? (
            <code
              content={node.text}
              filetype={infoStringToFiletype(node.lang)}
              syntaxStyle={syntaxStyle}
              conceal={false}
            />
          ) : (
            // Plain until the closing fence: the text never changes, only its colors will.
            <text content={node.text} />
          )}
        </box>
      );
    case "quote":
      return (
        <box
          {...layout}
          flexDirection="column"
          border={["left"]}
          borderColor={palette.quoteBar()}
          paddingLeft={1}
        >
          {node.children.map((child, i) => (
            <NodeView key={i} node={child} look={look} />
          ))}
        </box>
      );
    case "heading":
      return <HeadingView node={node} background={look.background} />;
    case "rule":
      return <box {...layout} height={1} border={["top"]} borderColor={palette.line()} />;
    case "table":
      // A table draws synchronously in OpenTUI's Markdown (no Tree-sitter): reuse it.
      // `streaming` makes it re-lex the table as rows arrive: otherwise it keeps the old
      // table token and lexes the new row alone, as a paragraph of raw pipes.
      return (
        <box {...layout}>
          <markdown content={node.raw} syntaxStyle={syntaxStyle} conceal streaming />
        </box>
      );
  }
}

// The column where each level's band starts fading out: fixed, so that a title that streams
// in never moves its band. The fade then runs to the right edge, whatever the width.
const FADE_FROM: Readonly<Record<number, number>> = { 1: 28, 2: 18, 3: 12 };
const TITLE_INDENT = 2;
// Past this much of the fade, a column is left unpainted: the terminal's own background,
// transparency included, shows at the edge.
const UNPAINTED = 0.95;

/**
 * A heading on its band: full under the first columns, then fading out up to the right
 * edge, into the terminal's background (`background`, from OSC 11) when it is known, else
 * in alpha. Painted, not text: a selection copies the title alone. Level 1 is three rows
 * tall, its title in the middle.
 */
function HeadingView({
  node,
  background,
}: {
  node: Extract<Node, { kind: "heading" }>;
  background: RGBA | undefined;
}) {
  const content = useMemo(() => new StyledText([...node.chunks]), [node.chunks]);
  const { band, level } = node;
  const paint = useMemo(() => {
    if (!band) return undefined;
    const from = FADE_FROM[level] ?? 0;
    return function (this: BoxRenderable, buffer: OptimizedBuffer) {
      // Read at every frame: a resized terminal moves the edge.
      const span = Math.max(1, this.width - from);
      for (let x = 0; x < this.width; x++) {
        const faded = Math.max(0, x + 1 - from) / span;
        if (faded >= UNPAINTED) break;
        buffer.fillRect(this.x + x, this.y, 1, this.height, fade(band, background, faded));
      }
    };
  }, [band, level, background]);
  return (
    <box
      marginTop={node.marginTop}
      flexShrink={0}
      paddingLeft={band ? TITLE_INDENT : 0}
      paddingY={band && level === 1 ? 1 : 0}
      renderBefore={paint}
    >
      <text content={content} />
    </box>
  );
}

/** `band` faded by `amount` (0 to 1) into `background`, or into transparency without it. */
function fade(band: RGBA, background: RGBA | undefined, amount: number) {
  if (!background) return RGBA.fromValues(band.r, band.g, band.b, band.a * (1 - amount));
  const mix = (a: number, b: number) => a + (b - a) * amount;
  return RGBA.fromValues(
    mix(band.r, background.r),
    mix(band.g, background.g),
    mix(band.b, background.b),
    1,
  );
}

function TextView({ chunks, marginTop }: { chunks: Chunks; marginTop: number }) {
  const content = useMemo(() => new StyledText([...chunks]), [chunks]);
  return <text content={content} marginTop={marginTop} flexShrink={0} />;
}
type Chunks = Extract<Node, { kind: "text" }>["chunks"];
