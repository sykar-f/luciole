# @luciole-sh/markdown-editor

A WYSIWYG Markdown editor for your terminal. Headings, bold, lists and code show as they read, with no Markdown
mark on screen, and Markdown goes in through `value` and comes out through `onChange`.

The package is published on npm as `@luciole-sh/markdown-editor`, under the MIT licence. It is at version 0.x, so a
minor release may change the API until 1.0.

## Install

```sh
bun add @luciole-sh/markdown-editor @opentui/core @opentui/react react
# or: npm install @luciole-sh/markdown-editor @opentui/core @opentui/react react
```

`react`, `@opentui/core` and `@opentui/react` are peer dependencies, so your project keeps a single copy of each.
The package is ESM only and ships its declarations. It runs on Node 26.4 or newer, the version OpenTUI needs, or
on Bun 1.3 or newer.

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
[`website/scripts/capture.py`](https://github.com/sykar-f/luciole/blob/v0.1.0/website/scripts/capture.py)
(`python3 website/scripts/capture.py markdown-editor`), and the program is
[`example/index.tsx`](https://github.com/sykar-f/luciole/blob/v0.1.0/packages/markdown-editor/example/index.tsx)._

The editor reads its colours from a `SyntaxStyle`, with the group names of Markdown highlighting
(`markup.heading.1`, `markup.strong`, `markup.raw.block` and so on). Without `syntaxStyle`, the text is plain and
headings have no band. If you build apps with `@luciole-sh/core`, its `markdownStyle(palette)` builds a complete
style that `<Markdown>` shares with the editor.

### Run the example from a clone

The same program is in the repository, in `packages/markdown-editor/example/`. From the root of
a clone, run:

```sh
bun install
bun packages/markdown-editor/example/index.tsx
```

`bun run check` type-checks that program, and `tests/readme-examples.test.ts` fails when this
page and the file differ. The same test type-checks every other example of this page.

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
| Ctrl+I, Alt+I                  | Italic (Ctrl+I only where your terminal tells it from Tab)        |
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

| Prop                 | Type                            | Default                                      | What it does                                                                                                                  |
| -------------------- | ------------------------------- | -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `value`              | `string`                        | required                                     | The document, as Markdown. It is controlled, like an input's `value`.                                                         |
| `onChange`           | `(markdown: string) => void`    | none                                         | Called after each edit with the Markdown. It does not fire for a `value` you set from outside.                                |
| `focused`            | `boolean`                       | `false`                                      | The editor receives keys and pastes while it has the focus.                                                                   |
| `syntaxStyle`        | `SyntaxStyle`                   | none                                         | The colours of the document. See the first editor above.                                                                      |
| `placeholder`        | `string`                        | none                                         | Faint text shown while the document is empty.                                                                                 |
| `selectionColor`     | `ColorInput`                    | the code panel's colour                      | The background of selected text.                                                                                              |
| `readingWidth`       | `number`                        | the editor's width                           | The widest the page runs, in cells. A narrower page is centred, and heading bands and code panels reach into its left margin. |
| `scrollbar`          | `boolean`                       | `true`                                       | A scrollbar down the right edge while the document is taller than the editor.                                                 |
| `terminalBackground` | `RGBA`                          | asked from your terminal                     | Your terminal's background, which heading bands fade into.                                                                    |
| `onLink`             | `(url: string) => void`         | none                                         | A link was clicked: a plain click while the editor is not focused, Ctrl or Alt+click while editing.                           |
| `onCopy`             | `(markdown: string) => void`    | copies to your terminal's clipboard (OSC 52) | The selection was copied or cut, as Markdown.                                                                                 |
| `onFocusRequest`     | `() => void`                    | the editor takes the focus                   | The editor was clicked while not focused. Set `focused` to grant it.                                                          |
| `math`               | `MathRenderer`                  | none                                         | Draws display math (`$$…$$`) as a picture in terminals that show pictures. Without it, display math shows its TeX.            |
| `ref`                | `Ref<MarkdownEditorRenderable>` | none                                         | The renderable, whose `controller` edits from outside.                                                                        |

`MarkdownEditorProps` is the type of these props. It is `MarkdownEditorOptions` with `value` required, plus
`focused` and `ref`. The component must render under OpenTUI's `createRoot`, which it reads the renderer from.

```ts
import type { MarkdownEditorProps } from "@luciole-sh/markdown-editor";

// What a notes screen sets once, whatever note it shows.
export const noteEditor: Omit<MarkdownEditorProps, "value"> = {
  placeholder: "Write a note…",
  readingWidth: 80,
  scrollbar: false,
};
```

`math` takes a `MathRenderer`: `(tex, { display, color, scale }) => Promise<Uint8Array>`. It returns a PNG of
the formula in `color`, a `#rrggbb` string, at `scale` pixels per TeX `ex`. When the promise rejects, the formula
keeps showing its TeX.

### `MarkdownEditorRenderable`

The OpenTUI renderable behind the component, for programs that do not use React. Create it with
`new MarkdownEditorRenderable(ctx, options)`. Its options are a `MarkdownEditorOptions`: the props above, except
`ref` and `focused`. Call `focus()` on the renderable instead of `focused`.

| Member        | What it gives                                                                                                               |
| ------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `controller`  | The `EditorController` that holds the document and edits it.                                                                |
| `value`       | The document as Markdown. Setting a value other than the last one reported reloads the document.                            |
| `wheelRoom()` | `{ up, down }`: whether the wheel can still move the text each way. In a web page, the page takes the wheel when it cannot. |

### `EditorController`

The editing engine, usable without a screen. A toolbar reaches it through `ref.current.controller`. No member
raises an error: an edit that does not apply leaves the document as it is.

| Member                                                                          | What it does                                                                                                     |
| ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `new EditorController(markdown?)`                                               | Creates a controller on a Markdown document, empty by default.                                                   |
| `markdown`                                                                      | The document as Markdown, as last reported.                                                                      |
| `subscribe(listener)`                                                           | Calls `listener(change)` with an `EditorChange` on each change, and returns a function that unsubscribes.        |
| `load(markdown)`                                                                | Replaces the document and clears the undo history. The cursor stays where it was when it still fits.             |
| `toggleMark(mark)`                                                              | Toggles a `MarkName` on the selection: `bold`, `italic`, `strike` or `code`.                                     |
| `setBlock(kind)`                                                                | Turns the selected blocks into a `BlockKind`. A block already of that kind becomes a paragraph.                  |
| `indent(1)`, `indent(-1)`                                                       | Indents or outdents the selected list items.                                                                     |
| `editLink()`                                                                    | Makes a link of the selection, or writes out the link at the cursor to edit it.                                  |
| `toggleTask(block)`                                                             | Ticks or unticks the task at block index `block`.                                                                |
| `undo()`, `redo()`, `canUndo`, `canRedo`                                        | Undo and redo, and whether there is a step to take.                                                              |
| `select(selection)`, `moveTo(pos, { extend? })`                                 | Sets the `Selection`, or moves the cursor to a `Pos`. With `extend: true`, the selection keeps its anchor.       |
| `selectAll()`, `end()`                                                          | Selects the whole document, or puts the cursor at its end.                                                       |
| `activeMarks`, `block`                                                          | The `Marks` of the selection or of the text typed next, and the `Block` the cursor is in.                        |
| `selectedMarkdown()`, `cut()`                                                   | The selection as Markdown. `cut()` removes it too.                                                               |
| `type(text)`, `enter()`, `backspace()`, `paste(markdown)`                       | The edits a key press makes.                                                                                     |
| `lineBreak()`, `deleteForward()`, `deleteWordBackward()`, `deleteWordForward()` | The other editing keys.                                                                                          |
| `settle()`                                                                      | Decides the delimiters still waiting for a key, as when the focus leaves.                                        |
| `leaveLast()`                                                                   | Adds a paragraph after a last block of code, table or rule, with the cursor in it. Returns whether it added one. |

The table lists what an app calls. The class has two more public members: `state`, which the renderable reads,
and `apply(edit)`, which the members above call. Both work on an `EditorState`, a type the package does not
export, so an app edits through the members above.

`EditorChange` is `{ markdown, edited }`. `edited` is `false` for a load or a cursor move. `BlockKind` is one of:

- `{ type: "paragraph" }`
- `{ type: "heading", level }`, with a `HeadingLevel`. A heading holds plain text, so its marks are dropped.
- `{ type: "quote" }`, which adds a quote around the blocks, or removes it
- `{ type: "item", list }`, with a `ListKind`
- `{ type: "code" }`

This toolbar logic makes a word bold, then reads which buttons show as pressed:

```ts
import { EditorController, type MarkName, type Selection } from "@luciole-sh/markdown-editor";

const editor = new EditorController("Pack the charger\n");
const charger: Selection = { anchor: { block: 0, offset: 9 }, head: { block: 0, offset: 16 } };
editor.select(charger);
editor.toggleMark("bold");
editor.markdown; // "Pack the **charger**"

const buttons: MarkName[] = ["bold", "italic", "strike", "code"];
export const pressed = buttons.filter((mark) => editor.activeMarks[mark]); // ["bold"]
```

## Read and write the document

`parseMarkdown(markdown)` returns the editor's document, a `Doc`, and `serializeMarkdown(doc)` writes it back as
Markdown. Neither needs a terminal, and neither raises an error. Markdown the editor does not model is kept as a
`raw` block, character for character.

```ts
import { parseMarkdown, serializeMarkdown } from "@luciole-sh/markdown-editor";

const doc = parseMarkdown("# Trip\n\n- [x] tickets\n");
doc[1]; // { type: "item", list: "task", indent: 0, checked: true, marker: "-", content: [{ text: "tickets", marks: {} }] }
serializeMarkdown(doc); // "# Trip\n\n- [x] tickets"
```

### The document types

The document is immutable. An edit builds new blocks and keeps the others, so a block you do not edit is written
back exactly as it was read.

| Type           | Shape                                                                    | Meaning                                                                                  |
| -------------- | ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| `Doc`          | `readonly Block[]`                                                       | The document. It is never empty: an empty document is one empty paragraph.               |
| `Block`        | `TextBlock \| LinesBlock \| RuleBlock`                                   | One block. Each has the fields of `Place`.                                               |
| `TextBlock`    | `paragraph`, `heading` or `item`, with `content: Inline`                 | A block of marked text. A `heading` has a `level`. An `item` has the fields below.       |
| `LinesBlock`   | `{ type: "code", lang, text }` or `{ type: "raw", text }`                | Plain lines: code, or Markdown kept as written, such as a table or HTML.                 |
| `RuleBlock`    | `{ type: "rule" }`                                                       | A thematic break, `---`.                                                                 |
| `Place`        | `{ quote?, break?, depth?, source? }`                                    | Where a block sits. See the next table.                                                  |
| `HeadingLevel` | `1` to `6`                                                               | A heading's level.                                                                       |
| `Inline`       | `readonly Span[]`                                                        | A block's text. It has no empty span, and no two neighbours with equal marks.            |
| `Span`         | `{ text, marks }`                                                        | A run of text that shares its `Marks`. A `"\n"` in `text` is a line break.               |
| `Marks`        | `{ bold?, italic?, strike?, code?, link?, title?, verbatim?, escaped? }` | Inline formatting. An absent mark is off.                                                |
| `MarkName`     | `"bold" \| "italic" \| "strike" \| "code"`                               | The marks `toggleMark` takes.                                                            |
| `ListKind`     | `"bullet" \| "ordered" \| "task"`                                        | The kind of a list item.                                                                 |
| `ListMarker`   | `"-" \| "*" \| "+" \| "." \| ")"`                                        | The character of an item's marker. `.` and `)` follow a number.                          |
| `Pos`          | `{ block, offset }`                                                      | A place between two characters. `offset` counts UTF-16 code units into the block's text. |
| `Selection`    | `{ anchor, head }`                                                       | Two `Pos`. `anchor` stays where the selection started, and `head` is the cursor.         |

An `item` has `list`, a `ListKind`, and `indent`, its list's level from 0 at the margin. It may have:

- `checked`, for a task
- `start`, the number of an ordered list's first item when it is not 1
- `marker`, a `ListMarker`. Two neighbouring lists with different markers are two lists.
- `loose: true`, for the items of a list whose items are a blank line apart

In `Marks`, `bold`, `italic`, `strike` and `code` are `true` when set. `link` is the target and `title` its
title. `verbatim` marks source the editor shows and writes back as it is, such as an image or inline HTML. `escaped`
marks punctuation meant as itself, such as `\*`, which is written back with its backslash.

| `Place` field | Type     | Meaning                                                                                               |
| ------------- | -------- | ----------------------------------------------------------------------------------------------------- |
| `quote`       | `number` | How many quotes the block is in. `> > text` is 2. Absent means 0.                                     |
| `break`       | `true`   | The block starts a quote of its own, apart from the quoted block above it.                            |
| `depth`       | `number` | For a block other than an item, how many list levels it is inside. At 1, it continues the item above. |
| `source`      | `string` | The block's Markdown as it was read. An edited block has none, and is written anew.                   |

This document, built by hand, shows most of the types:

```ts
import { serializeMarkdown, type Doc, type Span } from "@luciole-sh/markdown-editor";

const tickets: Span = { text: "tickets", marks: { bold: true } };
const doc: Doc = [
  { type: "heading", level: 2, content: [{ text: "Trip", marks: {} }] },
  { type: "item", list: "task", indent: 0, checked: true, content: [tickets] },
  {
    type: "item",
    list: "task",
    indent: 0,
    checked: false,
    content: [{ text: "charger", marks: {} }],
  },
  { type: "rule" },
  {
    type: "paragraph",
    quote: 1,
    content: [
      { text: "See ", marks: {} },
      { text: "the list", marks: { link: "https://example.com" } },
    ],
  },
];
serializeMarkdown(doc);
// "## Trip\n\n- [x] **tickets**\n- [ ] charger\n\n---\n\n> See [the list](https://example.com)"
```

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
- [`examples/notes`](https://github.com/sykar-f/luciole/tree/v0.1.0/examples/notes), a full app that edits notes with
  this editor
- [Package status](https://luciole.sh/status/)
