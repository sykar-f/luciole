/**
 * Markdown reader production smoke: built artefacts, separate Server and Client, real PTY.
 *
 * Journey on a temporary library: home document (README) rendered → next document → find
 * by name → scroll to the end → outline and jump to a heading → the file changes on disk
 * and the open document reloads in place → ignored directories stay out → quit.
 * Observes PTY output, not photons. MDREADER_PTY_FRAMES=<dir> writes each screen there.
 */
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { drive, type Driver, Keys } from "./driver";
import { BUN, build, example, report, startServer, temporaryDirectory } from "./harness";

const APP = example("mdreader");
const FRAMES = process.env.MDREADER_PTY_FRAMES;
// The bright selection of the list, which has the keys at start.
const SELECTED_BACKGROUND = "#1f3b4d";

const README = `# Handbook

Welcome to the **handbook**. It has *emphasis*, \`inline code\`, ~~old text~~ and a
[link to the project](https://example.com/project).

> A quotation, rendered with a bar on its left.

## Install

1. Clone the repository
2. Run the command below

\`\`\`ts
const answer: number = 42;
export function greet(name: string) {
  return \`hello \${name}\`;
}
\`\`\`

## Reference

| Key | Action |
| --- | ------ |
| j   | down   |
| k   | up     |

- [x] rendered task
- [ ] pending task
`;

function longGuide() {
  const parts = ["# Guide\n\nThe long document of the library.\n"];
  for (let section = 1; section <= 6; section++) {
    parts.push(`\n## Chapter ${section}\n`);
    for (let paragraph = 0; paragraph < 4; paragraph++)
      parts.push(
        `\nParagraph ${section}.${paragraph}: ` +
          "words that wrap across the reading width of the terminal. ".repeat(4) +
          "\n",
      );
  }
  parts.push("\n## Appendix\n\nLast words of the guide.\n");
  return parts.join("");
}

function library(directory: string) {
  const docs = join(directory, "library");
  mkdirSync(join(docs, "notes/deep"), { recursive: true });
  mkdirSync(join(docs, "node_modules/pkg"), { recursive: true });
  mkdirSync(join(docs, ".git"));
  writeFileSync(join(docs, "README.md"), README);
  writeFileSync(join(docs, "guide.md"), longGuide());
  writeFileSync(join(docs, "notes/alpha.md"), "# Alpha\n\nFirst note.\n");
  writeFileSync(join(docs, "notes/deep/beta note.md"), "# Beta\n\nA name with a space.\n");
  writeFileSync(join(docs, "node_modules/pkg/HIDDEN-DEP.md"), "# must not be listed\n");
  writeFileSync(join(docs, ".git/HIDDEN-GIT.md"), "# must not be listed\n");
  writeFileSync(join(docs, "notes/skip.txt"), "not markdown\n");
  return docs;
}

let frame = 0;
async function snapshot(t: Driver, name: string) {
  if (!FRAMES) return;
  frame += 1;
  mkdirSync(FRAMES, { recursive: true });
  await Bun.write(
    join(FRAMES, `${String(frame).padStart(2, "0")}-${name}.txt`),
    await t.snapshot(),
  );
}

/** A built Server on `mdPath` and a Client on a new PTY, with its own state directory. */
async function session(mdPath: string, state: string) {
  const server = await startServer(APP, { MD_PATH: mdPath });
  try {
    const t = await drive({
      command: [BUN, join(APP, ".luciole/client/index.js"), "--url", server.url],
      cols: 130,
      rows: 36,
      // A private state directory: the session file never reaches $HOME.
      env: { NODE_ENV: "production", XDG_STATE_HOME: state },
      settle: 150,
    });
    return {
      t,
      [Symbol.asyncDispose]: async () => {
        await t[Symbol.asyncDispose]();
        await server.stop();
      },
    };
  } catch (error: unknown) {
    await server.stop();
    throw error;
  }
}

build(APP);
using directory = temporaryDirectory("mdreader-pty-");
const docs = library(directory.path);
{
  await using library = await session(docs, join(directory.path, "state"));
  const { t } = library;
  // Home: README rendered, markers concealed, list without ignored directories.
  await t.waitFor("README.md");
  await t.waitFor("Handbook");
  await t.waitFor("hello ${name}");
  // Rendered: the table drawn, the markers concealed, the library counted.
  await t.waitFor("│j  │down");
  await t.waitFor((text) => !text.includes("# Handbook") && !text.includes("**handbook**"));
  await t.waitFor("4 documents");
  await snapshot(t, "home");
  const shown = await t.text();
  for (const listed of ["guide.md", "alpha.md", "beta note.md", "▾ notes/", "▾ deep/"])
    assert.ok(shown.includes(listed), listed);
  for (const hidden of ["HIDDEN", "skip.txt"]) assert.ok(!shown.includes(hidden), hidden);
  // The list has the keys at start: the open document is its bright selection.
  await t.until(async () => {
    const lines = await t.lines();
    const row = lines.findIndex((line) => line.startsWith(" │ README.md"));
    if (row < 0) return false;
    const style = await t.styleAt(row, lines[row]?.indexOf("README.md") ?? -1);
    return style.bg === SELECTED_BACKGROUND;
  }, "README.md is not the list's bright selection");

  // Browsing the list: the arrows select, the selected document opens.
  await t.type(Keys.down);
  await t.waitFor("First note.");
  await t.type("k");
  await t.waitFor("Welcome to the");
  // Tab gives the keys to the document: the arrows no longer change it.
  await t.type(Keys.tab);
  await t.waitFor("tab files");
  await t.type(Keys.down);
  // The document scrolled: the status gives the position read.
  await t.waitFor(/ \d+%/);
  const reading = await t.text();
  assert.ok(reading.includes("Welcome to the") && !reading.includes("First note."), reading);
  await snapshot(t, "reading");

  // Next document with ] (preloaded neighbour), back with [.
  await t.type("]");
  await t.waitFor("First note.");
  await snapshot(t, "next");
  await t.type("[");
  await t.waitFor("Welcome to the");

  // Find by name: the field owns the letters, Enter opens the pick.
  await t.type("/");
  await t.waitFor("name or path");
  await t.type("beta");
  await t.waitFor("notes/deep/beta note.md");
  await snapshot(t, "find");
  await t.type(Keys.enter);
  await t.waitFor("A name with a space.");

  // Scroll the long guide: page, end, top.
  await t.type("/");
  await t.type("guide");
  await t.type(Keys.enter);
  await t.waitFor("The long document of the library.");
  await t.waitFor("Top");
  await t.type(" ");
  await t.waitFor("Top", { absent: true });
  await t.type("G");
  await t.waitFor("Last words of the guide.");
  await t.waitFor("Bot");
  await snapshot(t, "end");
  await t.type("g");
  await t.waitFor("Top");

  // Outline: select Chapter 3, Enter keeps the position, the status names it.
  await t.type("t");
  await t.waitFor("outline");
  await t.waitFor("Appendix");
  await t.type("jjj");
  await snapshot(t, "outline");
  await t.type(Keys.enter);
  await t.waitFor("§ Chapter 3");
  await snapshot(t, "chapter");

  // A change on disk reloads the open document in place, position kept.
  const guide = join(docs, "guide.md");
  writeFileSync(
    guide,
    readFileSync(guide, "utf8").replace("## Chapter 3", "## Chapter 3 (edited)"),
  );
  await t.waitFor("reloaded from disk");
  await t.waitFor("§ Chapter 3 (edited)");
  await snapshot(t, "reloaded");
  writeFileSync(join(docs, "notes/gamma.md"), "# Gamma\n");
  await t.waitFor("gamma.md");
  await t.waitFor("5 documents");
  await t.quit();
}
{
  // A single file: no library, the document has the screen and the keys.
  await using single = await session(join(docs, "guide.md"), join(directory.path, "state-single"));
  const { t } = single;
  await t.waitFor("The long document of the library.");
  // Drawn to its status line: the library's frame, if any, would be there too.
  await t.waitFor("Top");
  await snapshot(t, "single");
  const shown = await t.text();
  assert.ok(
    !shown.includes("┌─ library") && !shown.includes("find") && !shown.includes("tab"),
    shown,
  );
  await t.type(Keys.down);
  await t.waitFor("Top", { absent: true });
  await t.quit();
}

report({
  productionPTY: true,
  concealedMarkdown: true,
  ignoredDirectories: true,
  listArrowsOpenTabFocusesDocument: true,
  nextPreviousFindScrollOutline: true,
  reloadInPlace: true,
  singleFileFullScreen: true,
  terminalRestored: true,
});
