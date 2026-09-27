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
  const stream = useMemo(
    () => new MarkdownStream(new Palette(syntaxStyle, { hyperlinks })),
    [syntaxStyle, hyperlinks],
  );
  const blocks = stream.update(content, streaming);
  return (
    <box flexDirection="column" flexShrink={0}>
      {blocks.map((block) => (
        <BlockView
          key={block.key}
          nodes={block.nodes}
          marginTop={block.marginTop}
          palette={stream.palette}
          syntaxStyle={syntaxStyle}
        />
      ))}
    </box>
  );
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

type BlockProps = {
  nodes: readonly Node[];
  marginTop: number;
  palette: Palette;
  syntaxStyle: SyntaxStyle;
};

/** One block: redrawn only when its nodes change, which finished blocks never do. */
const BlockView = memo(function BlockView({ nodes, marginTop, palette, syntaxStyle }: BlockProps) {
  return (
    <box flexDirection="column" flexShrink={0} marginTop={marginTop}>
      {nodes.map((node, i) => (
        <NodeView key={i} node={node} palette={palette} syntaxStyle={syntaxStyle} />
      ))}
    </box>
  );
});

function NodeView({
  node,
  palette,
  syntaxStyle,
}: {
  node: Node;
  palette: Palette;
  syntaxStyle: SyntaxStyle;
}) {
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
            <NodeView key={i} node={child} palette={palette} syntaxStyle={syntaxStyle} />
          ))}
        </box>
      );
    case "heading":
      return <HeadingView node={node} />;
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

// Where each level's band starts fading, and over how many columns: fixed, so a title that
// streams in never moves its band.
const FADE: Readonly<Record<number, { from: number; span: number }>> = {
  1: { from: 28, span: 52 },
  2: { from: 18, span: 62 },
  3: { from: 12, span: 40 },
};
const TITLE_INDENT = 2;

/**
 * A heading on its band: full under the first columns, then fading out (alpha, so it
 * blends into whatever is behind). The band is painted, not text: a selection copies the
 * title alone. Level 1 is three rows tall, its title in the middle.
 */
function HeadingView({ node }: { node: Extract<Node, { kind: "heading" }> }) {
  const content = useMemo(() => new StyledText([...node.chunks]), [node.chunks]);
  const { band, level } = node;
  const paint = useMemo(() => {
    if (!band) return undefined;
    const fade = FADE[level] ?? { from: 0, span: 1 };
    return function (this: BoxRenderable, buffer: OptimizedBuffer) {
      const columns = Math.min(this.width, fade.from + fade.span);
      for (let x = 0; x < columns; x++) {
        const alpha = band.a * (1 - Math.max(0, x - fade.from) / fade.span);
        buffer.fillRect(
          this.x + x,
          this.y,
          1,
          this.height,
          RGBA.fromValues(band.r, band.g, band.b, alpha),
        );
      }
    };
  }, [band, level]);
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

function TextView({ chunks, marginTop }: { chunks: Chunks; marginTop: number }) {
  const content = useMemo(() => new StyledText([...chunks]), [chunks]);
  return <text content={content} marginTop={marginTop} flexShrink={0} />;
}
type Chunks = Extract<Node, { kind: "text" }>["chunks"];
