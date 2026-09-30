/**
 * Files explorer production smoke: built artefacts, separate Server and Client, real PTY.
 *
 * Journey on a fixture tree: root listing → filter → image preview (half blocks, since the
 * PTY answers no kitty query) → text preview with line numbers → open a directory (loading
 * screen under latency) → code preview → back to the parent with the selection kept →
 * dotfiles → binary hex dump → zoom → quit. Observes PTY output, not photons.
 * FILES_PTY_FRAME=<file> writes the screen after the symlink checks there.
 *
 * Build first: bun packages/luciole/src/cli.ts build --app examples/files
 */
import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { crc32, deflateSync } from "node:zlib";
import { ctrl, drive, Keys, Mouse, paste } from "./driver";
import { BUN, example, numberFromEnv, report, startServer, temporaryDirectory } from "./harness";

const APP = example("files");
const LATENCY_MS = numberFromEnv("LUCIOLE_LATENCY_MS", 500);
// Under this simulated RTT loading screens and ghost rows are too brief to be caught.
const VISIBLE_LOADING_RTT_MS = 400;
const SETTLE_MS = 400;
const FILTER_TYPED_MS = 200;
const HALF_BLOCK = /[▀▄█▌▐]/;
// A 48×32 gradient drawn with half blocks: far more colour pairs than a palette would give.
const TRUECOLOR_PAIRS = 20;

/** A truecolor gradient, encoded by hand: no image library needed. */
function png(width: number, height: number) {
  const chunk = (kind: string, data: Uint8Array) => {
    const body = Buffer.concat([Buffer.from(kind, "latin1"), data]);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const checksum = Buffer.alloc(4);
    checksum.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, checksum]);
  };
  const rows: number[] = [];
  for (let y = 0; y < height; y++) {
    rows.push(0); // no filter
    for (let x = 0; x < width; x++)
      rows.push(Math.floor((x * 255) / width), Math.floor((y * 255) / height), 160);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8); // 8 bits, truecolor, no interlace
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(Buffer.from(rows))),
    chunk("IEND", new Uint8Array()),
  ]);
}

function fixture(base: string) {
  const tree = join(base, "tree");
  mkdirSync(join(tree, "src/nested"), { recursive: true });
  writeFileSync(join(tree, "src/app.ts"), "export const answer: number = 42;\n".repeat(3));
  writeFileSync(join(tree, "README.md"), "# Fixture\n\nSecond paragraph line.\n");
  writeFileSync(join(tree, ".hidden"), "secret\n");
  writeFileSync(join(tree, "picture.png"), png(48, 32));
  writeFileSync(
    join(tree, "data.bin"),
    Buffer.from([
      ...Array.from({ length: 256 }, (_, i) => i),
      ...Array.from({ length: 256 }, (_, i) => i),
    ]),
  );
  symlinkSync("src", join(tree, "link"));
  symlinkSync("nowhere", join(tree, "broken"));
  // Listed, but the Server refuses to follow it: it resolves outside the root.
  mkdirSync(join(base, "outside"));
  symlinkSync(join(base, "outside"), join(tree, "escape"));
  mkdirSync(join(base, "bin"));
  for (const tool of ["pbcopy", "wl-copy"]) {
    writeFileSync(join(base, "bin", tool), `#!/bin/sh\n/bin/cat > '${base}/clipboard.txt'\n`);
    chmodSync(join(base, "bin", tool), 0o755);
  }
  // Files to drop on the terminal, from outside the explorer root.
  const incoming = join(base, "incoming");
  mkdirSync(incoming);
  writeFileSync(join(incoming, "photo one.png"), png(8, 8));
  writeFileSync(join(incoming, "notes.txt"), "copied, not moved\n");
  symlinkSync("notes.txt", join(incoming, "notes link.txt"));
  writeFileSync(join(incoming, "README.md"), "same name as the root README\n");
  return tree;
}

using directory = temporaryDirectory("luciole-files-");
const base = directory.path;
const tree = fixture(base);
await using server = await startServer(APP, {
  FILES_ROOT: tree,
  LUCIOLE_TEST: "1",
  // Thumbnails are cached here, never in the user's ~/.cache.
  XDG_CACHE_HOME: join(base, "cache"),
});
await using t = await drive({
  command: [BUN, join(APP, ".luciole/client/index.js"), "--url", server.url],
  cols: 140,
  rows: 40,
  env: {
    NODE_ENV: "production",
    XDG_STATE_HOME: join(base, "state"),
    LUCIOLE_LATENCY_MS: String(LATENCY_MS),
    // A fake clipboard tool: copies land in a file, never in the user's clipboard.
    PATH: join(base, "bin"),
  },
});
/** The filter field takes focus on the next frame: type once it owns the keys. */
async function filter(text: string) {
  t.write("/");
  await t.waitFor("return done");
  await t.type(text, FILTER_TYPED_MS);
  t.write(Keys.enter);
}
/** What Ghostty sends when files are dropped: shell-escaped paths, bracketed paste. */
const drop = (...paths: string[]) =>
  t.write(paste(paths.map((path) => path.replaceAll(" ", "\\ ")).join(" ")));
const text = () => t.text();

await t.waitFor("TERMINAL / FILES");
await t.waitFor("src/");
// Dotfiles are hidden by default; directories come first.
assert.ok(!(await text()).includes(".hidden"));
assert.ok((await text()).indexOf("src/") < (await text()).indexOf("README.md"));

// Filter narrows locally; Enter leaves the field with the match selected.
await filter("pict");
await t.waitFor("1/8 shown");
await t.waitFor("drawn with truecolor half blocks (auto)");
await t.waitFor("48×32 px");
// The image arrives as a Server thumbnail (never enlarged), not as the file.
await t.waitFor("PNG 48×32 · thumbnail 48×32");
const thumbnails = join(base, "cache/luciole-files/thumbnails");
assert.ok(
  existsSync(thumbnails) && readdirSync(thumbnails).some((name) => name.endsWith(".webp")),
  "no cached thumbnail",
);
let shown = await text();
assert.ok(shown.includes("PNG image"), shown);
assert.ok(shown.includes("▀") || shown.includes("▄"), "no half-block glyph in the image pane");
// Half blocks carry two truecolor pixels per cell: the gradient needs many colours.
const colours = new Set(
  (await t.spans())
    .flat()
    .filter((span) => HALF_BLOCK.test(span.text))
    .map((span) => `${span.fg}/${span.bg}`),
);
assert.ok(
  colours.size > TRUECOLOR_PAIRS,
  `image pane is not truecolor: ${colours.size} colour pairs`,
);
// `p` forces kitty graphics: OpenTUI then emits APC `ESC _ G` image commands.
t.markOutput();
t.write("p");
await t.waitFor("drawn with kitty (forced)");
await t.pause(SETTLE_MS);
assert.ok(t.output().includes("\x1b_G"), "no kitty graphics command after forcing the protocol");
t.write("p");
await t.waitFor("drawn with truecolor half blocks (forced)");
t.write("p");
await t.waitFor("(auto)");

// Esc clears the filter; README shows its text with line numbers.
await t.escape();
await t.waitFor("7/8 shown");
t.write("G");
await t.waitFor("name      README.md");
await t.waitFor("Second paragraph line.");
await t.waitFor("markdown · 3 lines");
await t.waitFor("1 # Fixture");
await t.waitFor("3 Second paragraph line.");
await t.waitFor("Markdown");

// Opening a directory is a navigation: loading frame under latency, then listing.
t.write("g");
await t.waitFor("name      escape");
t.write("j");
await t.waitFor("name      link");
t.write("j");
await t.waitFor("name      src");
const start = performance.now();
t.write(Keys.enter);
if (LATENCY_MS >= VISIBLE_LOADING_RTT_MS) await t.waitFor("Opening src…");
const openedMs = (await t.waitFor("name      nested")) - start;
t.write("j");
await t.waitFor("export const answer");
await t.waitFor("typescript · 3 lines");

// Backspace returns to the parent with the directory we came from selected.
t.write(Keys.backspace);
await t.waitFor("name      src");
await t.waitFor("app.ts"); // the directory preview of src lists its children

// Sorting is local and keeps the selection.
t.write("s");
await t.waitFor("by size");
await t.waitFor("name      src");
t.write("s");
await t.waitFor("by modified");
t.write("s");
await t.waitFor("by name");

// A symlink to a directory inside the root opens; ~ returns to the root.
await filter("link");
await t.waitFor("name      link");
t.write(Keys.enter);
await t.waitFor("tree › link");
await t.waitFor("app.ts");
t.write("~");
await t.waitFor("tree · 8 entries");

// Dotfiles on demand, and the binary preview.
t.write(".");
await t.waitFor(".hidden");
await t.waitFor("dotfiles shown");
await filter("data");
await t.waitFor("00000000  00 01 02 03");
await t.waitFor("512 B · 512 bytes");
await t.escape();

// Zoom a file: the list disappears, Esc brings it back.
await filter("READ");
await t.waitFor("Second paragraph line.");
t.write(Keys.enter);
await t.pause(SETTLE_MS);
assert.ok(!(await text()).includes(" details "), await text());
await t.escape();
await t.waitFor(" details ");

// Right-click on a row: its context menu, which owns the keyboard until closed.
await t.click("≡ README.md", Mouse.right);
await t.waitFor("Copy full path");
t.write("j");
await t.pause(SETTLE_MS);
assert.ok((await text()).includes("name      README.md"), "the list moved under the menu");
await t.escape();
assert.ok(!(await text()).includes("Copy full path"));
await t.click("≡ README.md", Mouse.right);
await t.waitFor("Copy name");
await t.click("Copy name");
await t.waitFor("Copied name: README.md");
assert.equal(readFileSync(join(base, "clipboard.txt"), "utf8"), "README.md");
await t.click("≡ README.md", Mouse.right);
await t.waitFor("Copy full path");
await t.click("Copy full path");
await t.waitFor("Copied full path:");
assert.equal(
  readFileSync(join(base, "clipboard.txt"), "utf8"),
  join(realpathSync(tree), "README.md"),
);
// From the keyboard: m opens it on the selected row, Enter runs the first item.
t.write("m");
await t.waitFor("Preview full screen");
t.write(Keys.enter);
await t.pause(SETTLE_MS);
assert.ok(!(await text()).includes(" details "), "Enter did not open the preview full screen");
await t.escape();
await t.waitFor(" details ");

// A broken symlink is listed and reported, never followed.
await t.escape();
await filter("broken");
await t.waitFor("Broken symlink");

// Following a link out of the root is refused by the Server, not by the Client.
await t.escape();
await filter("escape");
await t.waitFor("Symlink to directory");
t.write(Keys.enter);
await t.waitFor("escape not found");
await t.waitFor("outside the explorer root");
t.write(Keys.enter);
await t.waitFor("picture.png");
if (process.env.FILES_PTY_FRAME) await Bun.write(process.env.FILES_PTY_FRAME, await t.snapshot());

// Drag and drop: applied on release. The file shows at once as a ghost row at its sorted
// place, then becomes the real entry. A file of this machine moves.
const incoming = join(base, "incoming");
await t.escape();
drop(join(incoming, "photo one.png"));
if (LATENCY_MS >= VISIBLE_LOADING_RTT_MS) {
  await t.waitFor("↓ photo one.png");
  await t.waitFor("arriving…");
  assert.ok((await text()).includes("is arriving into the root"), await text());
}
await t.waitFor("moved photo one.png");
await t.waitFor("name      photo one.png");
await t.waitFor("-rw-r--r--"); // the real entry, from the refreshed listing
assert.ok(!(await text()).includes("arriving…"));
assert.ok(!existsSync(join(incoming, "photo one.png")) && existsSync(join(tree, "photo one.png")));
// Sorted place: between picture.png and README.md.
shown = await text();
const at = (name: string) => shown.indexOf(name);
assert.ok(
  (at("picture.png") < at("photo one.png") && at("photo one.png") < at("README.md")) ||
    at("photo one.png") < at("picture.png"),
  shown,
);
// A dropped symlink is not "the same file" for the Server: its content is sent and copied,
// as for a Server on another machine; the link and its target stay.
drop(join(incoming, "notes link.txt"));
await t.waitFor("copied notes link.txt");
assert.ok(
  lstatSync(join(incoming, "notes link.txt")).isSymbolicLink() &&
    existsSync(join(incoming, "notes.txt")),
);
assert.equal(readFileSync(join(tree, "notes link.txt"), "utf8"), "copied, not moved\n");
assert.ok(!lstatSync(join(tree, "notes link.txt")).isSymbolicLink());
// Never overwritten.
drop(join(incoming, "README.md"));
await t.waitFor("README.md: a file with this name is already here");
assert.ok(readFileSync(join(tree, "README.md"), "utf8").startsWith("# Fixture"));

await t.quit(ctrl("c"));
report({
  productionPTY: true,
  simulatedRTTMs: LATENCY_MS,
  filterLocal: true,
  imageHalfBlocks: true,
  imageTruecolorPairs: colours.size,
  serverThumbnailCached: true,
  kittyWhenForced: true,
  textPreviewWithLineNumbers: true,
  openDirectoryMs: Math.round(openedMs),
  parentKeepsSelection: true,
  localSort: true,
  symlinkDirectoryAndRootKey: true,
  dotfilesToggle: true,
  binaryHexDump: true,
  zoom: true,
  contextMenuRightClick: true,
  contextMenuCopies: true,
  brokenSymlinkReported: true,
  symlinkOutsideRootRefused: true,
  dropGhostRow: LATENCY_MS >= VISIBLE_LOADING_RTT_MS,
  dropMovesWhenLocal: true,
  dropCopiesWhenNotSameFile: true,
  dropNeverOverwrites: true,
  terminalRestored: true,
});
