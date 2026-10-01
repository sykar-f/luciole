/**
 * `import "luciole/grammars"`: Tree-sitter grammars for the languages OpenTUI 0.5.12 does not
 * highlight on its own (it ships JavaScript, TypeScript, Markdown and Zig), and TypeScript
 * and TSX done right. Once imported,
 * `<code>`, `<diff>` and `<Markdown>` code blocks in these languages are highlighted.
 *
 * Opt-in, because each grammar is a WebAssembly file the build copies next to the bundle
 * (about 11 MB for all of them). The grammars are the official npm packages, pinned; each
 * ships its `.wasm` and its highlight queries at the same version. Their native bindings are
 * never built (Bun blocks their install scripts): only the WebAssembly is used. The web
 * target serves its own Tree-sitter files: there, these languages stay plain text.
 */
import { loadOptional } from "./optional";
import { addDefaultParsers, type FiletypeParserOptions } from "@opentui/core";
// OpenTUI's own TypeScript queries, fixed (see the file), and JSX on top for TSX.
import typescriptHighlights from "./queries/typescript.scm" with { type: "file" };
import jsxHighlights from "./queries/jsx.scm" with { type: "file" };
// Keys and punctuation the data languages' own queries leave out.
import jsonExtra from "./queries/json.scm" with { type: "file" };
import yamlKeys from "./queries/keys.yaml.scm" with { type: "file" };
import tomlKeys from "./queries/keys.toml.scm" with { type: "file" };

/**
 * Where a copied file is. The bundler writes its path relative to the bundle, and OpenTUI
 * resolves a relative path from the working directory, the user's project: resolve it from
 * this module. Absolute paths (run from source, `/$bunfs/…` in a compiled binary) and URLs
 * (the web target) come out as they were.
 */
function at(file: string) {
  const url = new URL(file, import.meta.url);
  return url.protocol === "file:" ? decodeURIComponent(url.pathname) : url.href;
}

const FEATURE = "luciole/grammars";

/**
 * The grammars are optional dependencies (docs/DEPENDENCIES.md): an app that never imports
 * this module does not install them, and one that lacks a package is told which to add.
 */
async function grammar(name: string, load: () => Promise<{ default: string }>) {
  return at((await loadOptional(FEATURE, name, load)).default);
}

const bash = await grammar(
  "tree-sitter-bash",
  () => import("tree-sitter-bash/tree-sitter-bash.wasm", { with: { type: "file" } }),
);
const bashHighlights = await grammar(
  "tree-sitter-bash",
  () => import("tree-sitter-bash/queries/highlights.scm", { with: { type: "file" } }),
);
const c = await grammar(
  "tree-sitter-c",
  () => import("tree-sitter-c/tree-sitter-c.wasm", { with: { type: "file" } }),
);
const cHighlights = await grammar(
  "tree-sitter-c",
  () => import("tree-sitter-c/queries/highlights.scm", { with: { type: "file" } }),
);
const cpp = await grammar(
  "tree-sitter-cpp",
  () => import("tree-sitter-cpp/tree-sitter-cpp.wasm", { with: { type: "file" } }),
);
const cppHighlights = await grammar(
  "tree-sitter-cpp",
  () => import("tree-sitter-cpp/queries/highlights.scm", { with: { type: "file" } }),
);
const css = await grammar(
  "tree-sitter-css",
  () => import("tree-sitter-css/tree-sitter-css.wasm", { with: { type: "file" } }),
);
const cssHighlights = await grammar(
  "tree-sitter-css",
  () => import("tree-sitter-css/queries/highlights.scm", { with: { type: "file" } }),
);
const go = await grammar(
  "tree-sitter-go",
  () => import("tree-sitter-go/tree-sitter-go.wasm", { with: { type: "file" } }),
);
const goHighlights = await grammar(
  "tree-sitter-go",
  () => import("tree-sitter-go/queries/highlights.scm", { with: { type: "file" } }),
);
const html = await grammar(
  "tree-sitter-html",
  () => import("tree-sitter-html/tree-sitter-html.wasm", { with: { type: "file" } }),
);
const htmlHighlights = await grammar(
  "tree-sitter-html",
  () => import("tree-sitter-html/queries/highlights.scm", { with: { type: "file" } }),
);
const java = await grammar(
  "tree-sitter-java",
  () => import("tree-sitter-java/tree-sitter-java.wasm", { with: { type: "file" } }),
);
const javaHighlights = await grammar(
  "tree-sitter-java",
  () => import("tree-sitter-java/queries/highlights.scm", { with: { type: "file" } }),
);
const json = await grammar(
  "tree-sitter-json",
  () => import("tree-sitter-json/tree-sitter-json.wasm", { with: { type: "file" } }),
);
const jsonHighlights = await grammar(
  "tree-sitter-json",
  () => import("tree-sitter-json/queries/highlights.scm", { with: { type: "file" } }),
);
const php = await grammar(
  "tree-sitter-php",
  () => import("tree-sitter-php/tree-sitter-php.wasm", { with: { type: "file" } }),
);
const phpHighlights = await grammar(
  "tree-sitter-php",
  () => import("tree-sitter-php/queries/highlights.scm", { with: { type: "file" } }),
);
const python = await grammar(
  "tree-sitter-python",
  () => import("tree-sitter-python/tree-sitter-python.wasm", { with: { type: "file" } }),
);
const pythonHighlights = await grammar(
  "tree-sitter-python",
  () => import("tree-sitter-python/queries/highlights.scm", { with: { type: "file" } }),
);
const ruby = await grammar(
  "tree-sitter-ruby",
  () => import("tree-sitter-ruby/tree-sitter-ruby.wasm", { with: { type: "file" } }),
);
const rubyHighlights = await grammar(
  "tree-sitter-ruby",
  () => import("tree-sitter-ruby/queries/highlights.scm", { with: { type: "file" } }),
);
const rust = await grammar(
  "tree-sitter-rust",
  () => import("tree-sitter-rust/tree-sitter-rust.wasm", { with: { type: "file" } }),
);
const rustHighlights = await grammar(
  "tree-sitter-rust",
  () => import("tree-sitter-rust/queries/highlights.scm", { with: { type: "file" } }),
);
const toml = await grammar(
  "@tree-sitter-grammars/tree-sitter-toml",
  () =>
    import("@tree-sitter-grammars/tree-sitter-toml/tree-sitter-toml.wasm", {
      with: { type: "file" },
    }),
);
const tomlHighlights = await grammar(
  "@tree-sitter-grammars/tree-sitter-toml",
  () =>
    import("@tree-sitter-grammars/tree-sitter-toml/queries/highlights.scm", {
      with: { type: "file" },
    }),
);
const yaml = await grammar(
  "@tree-sitter-grammars/tree-sitter-yaml",
  () =>
    import("@tree-sitter-grammars/tree-sitter-yaml/tree-sitter-yaml.wasm", {
      with: { type: "file" },
    }),
);
const yamlHighlights = await grammar(
  "@tree-sitter-grammars/tree-sitter-yaml",
  () =>
    import("@tree-sitter-grammars/tree-sitter-yaml/queries/highlights.scm", {
      with: { type: "file" },
    }),
);
const lua = await grammar(
  "@tree-sitter-grammars/tree-sitter-lua",
  () =>
    import("@tree-sitter-grammars/tree-sitter-lua/tree-sitter-lua.wasm", {
      with: { type: "file" },
    }),
);
const luaHighlights = await grammar(
  "@tree-sitter-grammars/tree-sitter-lua",
  () =>
    import("@tree-sitter-grammars/tree-sitter-lua/queries/highlights.scm", {
      with: { type: "file" },
    }),
);
const typescript = await grammar(
  "tree-sitter-typescript",
  () => import("tree-sitter-typescript/tree-sitter-typescript.wasm", { with: { type: "file" } }),
);
const tsx = await grammar(
  "tree-sitter-typescript",
  () => import("tree-sitter-typescript/tree-sitter-tsx.wasm", { with: { type: "file" } }),
);

/** Filetypes as OpenTUI names them (`infoStringToFiletype`), with the other names in use. */
export const GRAMMARS: readonly FiletypeParserOptions[] = [
  {
    filetype: "bash",
    aliases: ["shell", "sh", "zsh"],
    wasm: bash,
    queries: { highlights: [bashHighlights] },
  },
  { filetype: "c", wasm: c, queries: { highlights: [cHighlights] } },
  // C++ extends C: its queries only add to C's.
  { filetype: "cpp", wasm: cpp, queries: { highlights: [cHighlights, cppHighlights] } },
  { filetype: "css", wasm: css, queries: { highlights: [cssHighlights] } },
  {
    filetype: "go",
    aliases: ["golang"],
    wasm: go,
    queries: { highlights: [goHighlights] },
  },
  { filetype: "html", wasm: html, queries: { highlights: [htmlHighlights] } },
  { filetype: "java", wasm: java, queries: { highlights: [javaHighlights] } },
  { filetype: "lua", wasm: lua, queries: { highlights: [luaHighlights] } },
  {
    filetype: "json",
    aliases: ["jsonc"],
    wasm: json,
    queries: { highlights: [jsonHighlights, at(jsonExtra)] },
  },
  { filetype: "php", wasm: php, queries: { highlights: [phpHighlights] } },
  { filetype: "python", wasm: python, queries: { highlights: [pythonHighlights] } },
  { filetype: "ruby", wasm: ruby, queries: { highlights: [rubyHighlights] } },
  { filetype: "rust", wasm: rust, queries: { highlights: [rustHighlights] } },
  {
    filetype: "toml",
    wasm: toml,
    queries: { highlights: [tomlHighlights, at(tomlKeys)] },
  },
  // Replaces OpenTUI's TypeScript, whose queries drew every identifier as a constant.
  {
    filetype: "typescript",
    aliases: ["ts", "mts", "cts"],
    wasm: typescript,
    queries: { highlights: [at(typescriptHighlights)] },
  },
  // OpenTUI reads TSX with the TypeScript grammar, which JSX derails.
  {
    filetype: "typescriptreact",
    aliases: ["tsx"],
    wasm: tsx,
    queries: { highlights: [at(typescriptHighlights), at(jsxHighlights)] },
  },
  {
    filetype: "yaml",
    aliases: ["yml"],
    wasm: yaml,
    queries: { highlights: [yamlHighlights, at(yamlKeys)] },
  },
];

addDefaultParsers([...GRAMMARS]);
