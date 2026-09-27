/**
 * `import "airtty/grammars"`: Tree-sitter grammars for the languages OpenTUI 0.5.12 does not
 * highlight on its own (it ships JavaScript, TypeScript, Markdown and Zig). Once imported,
 * `<code>`, `<diff>` and `<Markdown>` code blocks in these languages are highlighted.
 *
 * Opt-in, because each grammar is a WebAssembly file the build copies next to the bundle
 * (about 11 MB for all of them). The grammars are the official npm packages, pinned; each
 * ships its `.wasm` and its highlight queries at the same version. Their native bindings are
 * never built (Bun blocks their install scripts): only the WebAssembly is used. The web
 * target serves its own Tree-sitter files: there, these languages stay plain text.
 */
import { addDefaultParsers, type FiletypeParserOptions } from "@opentui/core";
import bash from "tree-sitter-bash/tree-sitter-bash.wasm" with { type: "file" };
import bashHighlights from "tree-sitter-bash/queries/highlights.scm" with { type: "file" };
import c from "tree-sitter-c/tree-sitter-c.wasm" with { type: "file" };
import cHighlights from "tree-sitter-c/queries/highlights.scm" with { type: "file" };
import cpp from "tree-sitter-cpp/tree-sitter-cpp.wasm" with { type: "file" };
import cppHighlights from "tree-sitter-cpp/queries/highlights.scm" with { type: "file" };
import css from "tree-sitter-css/tree-sitter-css.wasm" with { type: "file" };
import cssHighlights from "tree-sitter-css/queries/highlights.scm" with { type: "file" };
import go from "tree-sitter-go/tree-sitter-go.wasm" with { type: "file" };
import goHighlights from "tree-sitter-go/queries/highlights.scm" with { type: "file" };
import html from "tree-sitter-html/tree-sitter-html.wasm" with { type: "file" };
import htmlHighlights from "tree-sitter-html/queries/highlights.scm" with { type: "file" };
import java from "tree-sitter-java/tree-sitter-java.wasm" with { type: "file" };
import javaHighlights from "tree-sitter-java/queries/highlights.scm" with { type: "file" };
import json from "tree-sitter-json/tree-sitter-json.wasm" with { type: "file" };
import jsonHighlights from "tree-sitter-json/queries/highlights.scm" with { type: "file" };
import php from "tree-sitter-php/tree-sitter-php.wasm" with { type: "file" };
import phpHighlights from "tree-sitter-php/queries/highlights.scm" with { type: "file" };
import python from "tree-sitter-python/tree-sitter-python.wasm" with { type: "file" };
import pythonHighlights from "tree-sitter-python/queries/highlights.scm" with { type: "file" };
import ruby from "tree-sitter-ruby/tree-sitter-ruby.wasm" with { type: "file" };
import rubyHighlights from "tree-sitter-ruby/queries/highlights.scm" with { type: "file" };
import rust from "tree-sitter-rust/tree-sitter-rust.wasm" with { type: "file" };
import rustHighlights from "tree-sitter-rust/queries/highlights.scm" with { type: "file" };
import toml from "@tree-sitter-grammars/tree-sitter-toml/tree-sitter-toml.wasm" with { type: "file" };
import tomlHighlights from "@tree-sitter-grammars/tree-sitter-toml/queries/highlights.scm" with { type: "file" };
import yaml from "@tree-sitter-grammars/tree-sitter-yaml/tree-sitter-yaml.wasm" with { type: "file" };
import yamlHighlights from "@tree-sitter-grammars/tree-sitter-yaml/queries/highlights.scm" with { type: "file" };

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

/** Filetypes as OpenTUI names them (`infoStringToFiletype`), with the other names in use. */
export const GRAMMARS: readonly FiletypeParserOptions[] = [
  {
    filetype: "bash",
    aliases: ["shell", "sh", "zsh"],
    wasm: at(bash),
    queries: { highlights: [at(bashHighlights)] },
  },
  { filetype: "c", wasm: at(c), queries: { highlights: [at(cHighlights)] } },
  // C++ extends C: its queries only add to C's.
  { filetype: "cpp", wasm: at(cpp), queries: { highlights: [at(cHighlights), at(cppHighlights)] } },
  { filetype: "css", wasm: at(css), queries: { highlights: [at(cssHighlights)] } },
  {
    filetype: "go",
    aliases: ["golang"],
    wasm: at(go),
    queries: { highlights: [at(goHighlights)] },
  },
  { filetype: "html", wasm: at(html), queries: { highlights: [at(htmlHighlights)] } },
  { filetype: "java", wasm: at(java), queries: { highlights: [at(javaHighlights)] } },
  {
    filetype: "json",
    aliases: ["jsonc"],
    wasm: at(json),
    queries: { highlights: [at(jsonHighlights)] },
  },
  { filetype: "php", wasm: at(php), queries: { highlights: [at(phpHighlights)] } },
  { filetype: "python", wasm: at(python), queries: { highlights: [at(pythonHighlights)] } },
  { filetype: "ruby", wasm: at(ruby), queries: { highlights: [at(rubyHighlights)] } },
  { filetype: "rust", wasm: at(rust), queries: { highlights: [at(rustHighlights)] } },
  { filetype: "toml", wasm: at(toml), queries: { highlights: [at(tomlHighlights)] } },
  { filetype: "yaml", wasm: at(yaml), queries: { highlights: [at(yamlHighlights)] } },
];

addDefaultParsers([...GRAMMARS]);
