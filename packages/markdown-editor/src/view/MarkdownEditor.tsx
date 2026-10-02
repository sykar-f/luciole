import { useEffect, useState, type Ref } from "react";
import { RGBA } from "@opentui/core";
import { extend, useRenderer } from "@opentui/react";
import { MarkdownEditorRenderable, type MarkdownEditorOptions } from "./EditorRenderable.ts";

extend({ "markdown-editor": MarkdownEditorRenderable });
declare module "@opentui/react" {
  interface OpenTUIComponents {
    "markdown-editor": typeof MarkdownEditorRenderable;
  }
}

export type MarkdownEditorProps = Omit<MarkdownEditorOptions, "value" | "onChange"> & {
  /** The document, as Markdown: controlled, like an input's value. */
  value: string;
  onChange?: (markdown: string) => void;
  /** Keys and pastes go to the editor while it has the focus. */
  focused?: boolean;
  /** The renderable, whose `controller` formats and edits from outside (a toolbar). */
  ref?: Ref<MarkdownEditorRenderable>;
};

/**
 * A WYSIWYG Markdown editor: the document shows as it reads, and Markdown typed turns
 * into what it means as it is typed (`**` bold, `# ` a heading, `- ` a list). `value` and
 * `onChange` carry Markdown. Copying puts Markdown on the terminal's clipboard (OSC 52)
 * unless `onCopy` says otherwise.
 */
export function MarkdownEditor({ onCopy, ...props }: MarkdownEditorProps) {
  const renderer = useRenderer();
  const background = useTerminalBackground();
  return (
    <markdown-editor
      {...props}
      terminalBackground={props.terminalBackground ?? background}
      onCopy={onCopy ?? ((markdown: string) => void renderer.copyToClipboardOSC52(markdown))}
    />
  );
}

// How long the terminal has to report its colors before bands fade in transparency.
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
          if (live && colors.defaultBackground)
            setBackground(RGBA.fromHex(colors.defaultBackground));
        })
        .catch(() => undefined);
    };
    ask();
    // A theme switch changes the background. The renderer is an EventEmitter, typed only
    // with Node's types, which this package does not load: reached through Reflect.
    const listen = (method: "on" | "off") => {
      const handler: unknown = Reflect.get(renderer, method);
      if (typeof handler === "function") Reflect.apply(handler, renderer, ["theme_mode", ask]);
    };
    listen("on");
    return () => {
      live = false;
      listen("off");
    };
  }, [renderer]);
  return background;
}
