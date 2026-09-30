/**
 * `@luciole/editor`: a true WYSIWYG Markdown editor for the terminal. Use it in a Client
 * Component (`"use client"`): Markdown goes in and comes out, the screen shows none of it.
 *
 * Layers, each usable alone: the document model (`model/`), Markdown in and out
 * (`markdown/`), editing as pure functions of a state (`editing/`), and the view: layout,
 * drawing, keys, the OpenTUI renderable and its React component (`view/`).
 */
export { MarkdownEditor, type MarkdownEditorProps } from "./view/MarkdownEditor.tsx";
export {
  MarkdownEditorRenderable,
  type MarkdownEditorOptions,
  type MathRenderer,
} from "./view/EditorRenderable.ts";
export { EditorController, type EditorChange } from "./editing/controller.ts";
export type { BlockKind } from "./editing/commands.ts";
export { parseMarkdown } from "./markdown/parse.ts";
export { serializeMarkdown } from "./markdown/serialize.ts";
export type * from "./model/types.ts";
