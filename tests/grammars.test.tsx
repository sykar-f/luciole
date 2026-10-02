/** @jsxImportSource @opentui/react */
import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { testRender } from "@opentui/react/test-utils";
import { GRAMMARS } from "../packages/core/src/grammars";
import { syntax } from "../packages/harness/src/ui/syntax";

// A line of each language: enough tokens for several highlight groups.
const SNIPPETS: Record<string, string> = {
  bash: 'for f in *.txt; do echo "$f"; done # loop',
  c: 'int main(void) { return printf("hi %d", 42); } // c',
  cpp: 'class A { public: int x = 1; }; std::string s = "hi"; // cpp',
  css: ".btn:hover { color: #fff; margin: 4px; } /* css */",
  go: 'func main() { fmt.Println("hi", 42) } // go',
  html: '<div class="box"><p>Hi</p></div><!-- c -->',
  java: 'public class A { static int x = 42; String s = "hi"; } // j',
  json: '{"name": "coder", "version": 1, "ok": true, "none": null}',
  lua: 'local function greet(name) return "Hello " .. name end -- l',
  php: '<?php function hi($name) { return "Hello $name"; } // p',
  python: 'def greet(name: str) -> str:\n    return f"Hello {name}"  # hi',
  ruby: 'def greet(name) = "Hello #{name}" # hi\nputs greet(:x)',
  rust: 'fn main() { let x: u32 = 42; println!("{}", x); } // r',
  toml: '[package]\nname = "coder"\nversion = 1 # t',
  typescript: "const greet = (name: string): number => { return 42; }; // ts",
  typescriptreact: 'const App = () => <box id="a">{"hi"}</box>; // tsx',
  yaml: 'name: coder\nversion: 1\nlist:\n  - "a" # y',
};
const MIN_COLORS = 3;
const PASSES = 100;

type Setup = Awaited<ReturnType<typeof testRender>>;
let opened: Setup | undefined;
afterEach(() => {
  opened?.renderer.destroy();
  opened = undefined;
});

test("every grammar is registered with a snippet to check it", () => {
  expect(GRAMMARS.map((grammar) => grammar.filetype).toSorted()).toEqual(
    Object.keys(SNIPPETS).toSorted(),
  );
});

// A grammar whose WebAssembly or queries no longer load (an ABI change in web-tree-sitter,
// a query naming a node the grammar dropped) leaves its code in one color.
test.each(Object.entries(SNIPPETS))("%s code is highlighted", async (filetype, code) => {
  opened = await testRender(<code content={code} filetype={filetype} syntaxStyle={syntax} />, {
    width: 70,
    height: 5,
  });
  const setup = opened;
  let colors = 0;
  for (let pass = 0; pass < PASSES && colors < MIN_COLORS; pass++) {
    await act(async () => {
      await setup.renderOnce();
      await Bun.sleep(20);
    });
    const seen = setup
      .captureSpans()
      .lines.flatMap((line) => line.spans.filter((span) => span.text.trim()))
      .map((span) => [span.fg.r, span.fg.g, span.fg.b].join());
    colors = new Set(seen).size;
  }
  expect(colors).toBeGreaterThanOrEqual(MIN_COLORS);
});
