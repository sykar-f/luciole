# @luciole-sh/markdown-editor

A WYSIWYG Markdown editor for the terminal. Headings, bold, lists and code show as they read, with no Markdown
mark on screen, and Markdown goes in through `value` and comes out through `onChange`.

The package is published on npm as `@luciole-sh/markdown-editor`, under the MIT licence. It is at version 0.x, so a
minor release may change the API until 1.0.

## Install

```sh
bun add @luciole-sh/markdown-editor @opentui/core @opentui/react react
# or: npm install @luciole-sh/markdown-editor @opentui/core @opentui/react react
```

`react`, `@opentui/core` and `@opentui/react` are peer dependencies, so your project keeps a single copy of each.
The package is ESM only and ships its declarations. It runs on Bun 1.3 or newer. Under Node, OpenTUI asks for
version 26.4 or newer.

## Run a first editor

This program opens a note in an empty project. It needs the install above and a `tsconfig.json` that tells the
compiler to use OpenTUI for JSX:

```json
{
  "compilerOptions": {
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "jsx": "react-jsx",
    "jsxImportSource": "@opentui/react",
    "strict": true,
    "skipLibCheck": true,
    "noEmit": true
  }
}
```

Save this as `index.tsx` and run `bun index.tsx`. Ctrl+C quits.

```tsx
import { RGBA, SyntaxStyle, createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
import { useState } from "react";
import { MarkdownEditor } from "@luciole-sh/markdown-editor";

// The editor reads its colors from a SyntaxStyle. These groups are enough for headings on a
// band, bold and italic, inline code, a code panel, links and list markers.
const color = (hex: string) => RGBA.fromHex(hex);
const style = SyntaxStyle.fromStyles({
  default: { fg: color("#e6edf3") },
  conceal: { fg: color("#6e7681") },
  "markup.heading.1": {
    fg: color("#0d1117"),
    bg: color("#e8b84a"),
    bold: true,
  },
  "markup.heading.2": { fg: color("#e8b84a"), bold: true },
  "markup.strong": { bold: true },
  "markup.italic": { italic: true },
  "markup.raw": { fg: color("#a5d6ff") },
  "markup.raw.block": { bg: color("#161b22") },
  "markup.link": { fg: color("#58a6ff"), underline: true },
  "markup.list": { fg: color("#e8b84a") },
});

const NOTE = `# Packing list

Things to **remember** before the trip:

- passport
- [ ] charger
- [x] tickets

Run \`bun run build\` when you are back.
`;

function App() {
  const [markdown, setMarkdown] = useState(NOTE);
  return (
    <box flexDirection="column" flexGrow={1}>
      <MarkdownEditor
        value={markdown}
        onChange={setMarkdown}
        syntaxStyle={style}
        focused
        flexGrow={1}
      />
      <text>{`${markdown.length} characters of Markdown. Ctrl+C quits.`}</text>
    </box>
  );
}

createRoot(await createCliRenderer()).render(<App />);
```

The note appears as it reads. The heading sits on a coloured band, `**remember**` is bold, and the tasks have
boxes:

```text

  Packing list


Things to remember before the trip:

• passport
[ ] charger
[✓] tickets

Run bun run build when you are back.

136 characters of Markdown. Ctrl+C quits.
```

_The program above, in a 72×13 terminal. The frame is captured from a real PTY by
[`website/scripts/capture.py`](https://github.com/sykar-f/luciole/blob/main/website/scripts/capture.py)
(`python3 website/scripts/capture.py markdown-editor`), and the program is
[`example/index.tsx`](https://github.com/sykar-f/luciole/blob/main/packages/markdown-editor/example/index.tsx)._

The editor reads its colours from a `SyntaxStyle`, with the group names of Markdown highlighting
(`markup.heading.1`, `markup.strong`, `markup.raw.block` and so on). Without `syntaxStyle`, the text is plain and
headings have no band. If you build apps with `@luciole-sh/core`, its `markdownStyle(palette)` builds a complete
style that `<Markdown>` shares with the editor.

## Type Markdown, get the result

The editor turns Markdown into what it means as you type it.

| You type                                       | You get                                             |
| ---------------------------------------------- | --------------------------------------------------- |
| `**word**`, `*word*`, `` `word` ``, `~~word~~` | bold, italic, code, strikethrough                   |
| `# `, `## ` and so on at the line start        | a heading of that level                             |
| `- `, `* `, `1. `, `[ ] `, `> `                | a bullet list, a numbered list, a task, a quote     |
| ` ``` ` then Enter, `---` then Enter           | a code block (` ```ts ` colours TypeScript), a rule |
| `[text](url)`, or a URL then a space           | a link                                              |
| `\*`                                           | a plain star                                        |

- **Closing delimiters.** A delimiter waits for the next key. Before a word it opens, after a word it closes, and
  before a space it stays a character, as in `2 * 3`. What it opens closes by itself at the end of the block, so the
  Markdown the editor emits is always balanced.
- **Backspace** right after a conversion undoes it and gives back the characters you typed. At the start of a
  heading, list item or quote, it removes the block's mark. Enter on an empty list item leaves the list.
- **Selections.** A delimiter typed over a selection wraps it. Pasting inserts Markdown, so blocks and marks arrive
  as written.
- **Untouched text.** A block you do not edit is written back exactly as it was read, so opening and closing a note
  does not reformat it.

The editor also draws tables, task boxes, footnotes, GitHub alerts, `==highlights==`, `<kbd>` keys and Unicode
math. The block holding the cursor shows its Markdown, and the others show what it means.

### Keys

| Keys                           | Action                                                            |
| ------------------------------ | ----------------------------------------------------------------- |
| Ctrl+B, Alt+B                  | Bold                                                              |
| Ctrl+I, Alt+I                  | Italic (Ctrl+I only where the terminal tells it from Tab)         |
| Alt+S, Alt+E                   | Strikethrough, inline code                                        |
| Ctrl+K, Alt+K                  | Make or edit a link                                               |
| Alt+0 to Alt+6                 | Paragraph, or a heading of level 1 to 6                           |
| Alt+L, Alt+O, Alt+Q, Alt+T     | Bullet list, numbered list, quote, tick a task                    |
| Tab, Shift+Tab                 | Indent or outdent a list item. Elsewhere the key goes to your app |
| Ctrl+Z, Ctrl+Shift+Z or Ctrl+Y | Undo, redo                                                        |
| Alt+C, Alt+X, or Cmd+C, Cmd+X  | Copy, cut, as Markdown                                            |

Your own key handlers run before the editor's. OpenTUI gives a key to the focused editor only when no global
handler took it.

## Props

### `MarkdownEditor`

The React component. It takes every OpenTUI layout prop (`flexGrow`, `width`, `height` and so on) and these:

| Prop                 | Type                            | Default                                     | What it does                                                                                                                  |
| -------------------- | ------------------------------- | ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `value`              | `string`                        | required                                    | The document, as Markdown. It is controlled, like an input's `value`.                                                         |
| `onChange`           | `(markdown: string) => void`    | none                                        | Called after each edit with the Markdown. It does not fire for a `value` you set from outside.                                |
| `focused`            | `boolean`                       | `false`                                     | The editor receives keys and pastes while it has the focus.                                                                   |
| `syntaxStyle`        | `SyntaxStyle`                   | none                                        | The colours of the document. See the first editor above.                                                                      |
| `placeholder`        | `string`                        | none                                        | Faint text shown while the document is empty.                                                                                 |
| `selectionColor`     | `ColorInput`                    | the code panel's colour                     | The background of selected text.                                                                                              |
| `readingWidth`       | `number`                        | the editor's width                          | The widest the page runs, in cells. A narrower page is centred, and heading bands and code panels reach into its left margin. |
| `scrollbar`          | `boolean`                       | `true`                                      | A scrollbar down the right edge while the document is taller than the editor.                                                 |
| `terminalBackground` | `RGBA`                          | asked from the terminal                     | The terminal's background, which heading bands fade into.                                                                     |
| `onLink`             | `(url: string) => void`         | none                                        | A link was clicked: a plain click while the editor is not focused, Ctrl or Alt+click while editing.                           |
| `onCopy`             | `(markdown: string) => void`    | copies to the terminal's clipboard (OSC 52) | The selection was copied or cut, as Markdown.                                                                                 |
| `onFocusRequest`     | `() => void`                    | the editor takes the focus                  | The editor was clicked while not focused. Set `focused` to grant it.                                                          |
| `math`               | `MathRenderer`                  | none                                        | Draws display math (`$$…$$`) as a picture in terminals that show pictures. Without it, display math shows its TeX.            |
| `ref`                | `Ref<MarkdownEditorRenderable>` | none                                        | The renderable, whose `controller` edits from outside.                                                                        |

### `MarkdownEditorRenderable`

The OpenTUI renderable behind the component, for programs that do not use React. Create it with
`new MarkdownEditorRenderable(ctx, options)`. Its `options` are the props above, except `ref` and `focused`: call
`focus()` on the renderable instead.

| Member        | What it gives                                                                                                               |
| ------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `controller`  | The `EditorController` that holds the document and edits it.                                                                |
| `value`       | The document as Markdown. Setting a value other than the last one reported reloads the document.                            |
| `wheelRoom()` | `{ up, down }`: whether the wheel can still move the text each way. In a web page, the page takes the wheel when it cannot. |

### `EditorController`

The editing engine, usable without a screen. A toolbar reaches it through `ref.current.controller`.

| Member                                                    | What it does                                                                                                                                      |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `new EditorController(markdown?)`                         | Creates a controller on a Markdown document.                                                                                                      |
| `markdown`                                                | The document as Markdown, as last reported.                                                                                                       |
| `subscribe(listener)`                                     | Calls `listener({ markdown, edited })` on each change, and returns a function that unsubscribes. `edited` is `false` for a load or a cursor move. |
| `load(markdown)`                                          | Replaces the document.                                                                                                                            |
| `toggleMark("bold")`                                      | Toggles a mark on the selection: `bold`, `italic`, `strike`, `code`.                                                                              |
| `setBlock({ type: "heading", level: 2 })`                 | Turns the selected blocks into a `BlockKind`: paragraph, heading, quote, list item or code.                                                       |
| `indent(1)`, `indent(-1)`                                 | Indents or outdents the selected list items.                                                                                                      |
| `undo()`, `redo()`, `end()`                               | Undo, redo, and move the cursor to the end.                                                                                                       |
| `activeMarks`, `block`                                    | The marks and the block under the cursor.                                                                                                         |
| `type(text)`, `enter()`, `backspace()`, `paste(markdown)` | The edits a key press makes.                                                                                                                      |

### Markdown in and out

`parseMarkdown(markdown)` returns the editor's document, and `serializeMarkdown(doc)` writes it back. Neither
needs a terminal. The document types are exported too, and so are `EditorChange`, `BlockKind`,
`MarkdownEditorOptions` and `MathRenderer`.

## How it is built

The package has four layers, each usable alone. The first three need no terminal.

- **Document model.** Immutable blocks (paragraph, heading, quote, list item, code, raw text, rule) made of marked text.
- **Markdown.** The round trip through the GFM lexer of `marked`. What the editor does not model is kept as
  written.
- **Editing.** Edits as pure functions of a state, the typing rules, undo history and `EditorController`.
- **View.** Layout, drawing, the key table, Tree-sitter colouring of code, the OpenTUI renderable and the React
  component.

## Limits

- A quote inside a list item (`- a` then `  > b`) shows as its Markdown, because quotes hold lists and not the
  reverse.
- A table shows its pipes while the cursor is in it, and you edit it as Markdown. HTML and link definitions are
  edited as Markdown too.
- An image appears as a picture only in a terminal that draws pictures (the Kitty graphics protocol or sixel). Other
  terminals show its alternative text.
- A setext underline (`===` under a paragraph) cannot be typed. Enter already separates blocks, as a blank line does.
- Display math shows its TeX unless you pass a `math` renderer. `@luciole-sh/core/math` has one.
- The editor needs a terminal and OpenTUI. It does not draw in a web page by itself.

## Tests

The suite checks the editor against these:

- **The 652 examples of the CommonMark 0.31.2 spec** and a GFM corpus (`test/spec.test.ts`). Each example is read and
  written back from scratch, keeps its meaning, and writes the same form again.
- **5,000 random documents** (`test/fuzz.test.ts`, fixed seed). Written as Markdown and read again, they come back
  identical.
- **Typing, key by key** (`test/typing.test.ts`), through OpenTUI's real key decoding, on xterm, the kitty protocol
  and a Mac AZERTY keyboard.
- **Rendering, cell by cell** (`test/view.test.tsx`): heading bands, spacing, quote bars, list alignment, code
  panels and the scrollbar.

## Next

- [luciole documentation](https://luciole.sh/docs/), including the
  [API reference](https://luciole.sh/docs/reference/api/)
- [`examples/notes`](https://github.com/sykar-f/luciole/tree/main/examples/notes), a full app that edits notes with
  this editor
- [Package status](https://luciole.sh/status/)
