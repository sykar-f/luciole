import { RGBA, SyntaxStyle, createCliRenderer, type CliRenderer } from "@opentui/core";
import { createRoot, useRenderer } from "@opentui/react";
import { useState } from "react";
import { MarkdownEditor } from "@luciole-sh/markdown-editor";

// The editor reads its colors from a SyntaxStyle. These groups are enough for headings on a
// band, bold and italic, inline code, a code panel, links and list markers.
const color = (hex: string) => RGBA.fromHex(hex);

const styles = new WeakMap<CliRenderer, SyntaxStyle>();
function styleFor(renderer: CliRenderer) {
  const known = styles.get(renderer);
  if (known) return known;
  const style = SyntaxStyle.fromStyles(
    {
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
    },
    renderer.nativeScene,
  );
  styles.set(renderer, style);
  return style;
}

const NOTE = `# Packing list

Things to **remember** before the trip:

- passport
- [ ] charger
- [x] tickets

Run \`bun run build\` when you are back.
`;

function App() {
  const renderer = useRenderer();
  const style = styleFor(renderer);
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

const renderer = await createCliRenderer();
createRoot(renderer).render(<App />);
