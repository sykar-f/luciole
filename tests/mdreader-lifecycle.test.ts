/** A late heading sample must not read a destroyed native text view. */
import { expect, test } from "bun:test";
import { MarkdownRenderable } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { locateHeadings } from "../examples/mdreader/components/rendering";
import { syntaxFor } from "../examples/mdreader/components/syntax";

test("mdreader ignores a heading block whose native view has closed", async () => {
  const ui = await createTestRenderer({ width: 40, height: 8 });
  try {
    const markdown = new MarkdownRenderable(ui.renderer, {
      content: "# Heading\n\nBody.\n",
      syntaxStyle: syntaxFor(ui.renderer),
      width: 40,
    });
    ui.renderer.root.add(markdown);
    await ui.renderOnce();
    expect(locateHeadings(markdown, 0).map((heading) => heading.text)).toEqual(["Heading"]);
    const block = markdown._blockStates.find((block) => "lineInfo" in block.renderable);
    if (!block) throw new Error("The heading never created a native text block");
    // Recursive teardown can destroy the child while a queued sample still holds
    // its Markdown owner and the owner's block metadata.
    block.renderable.destroy();
    expect(locateHeadings(markdown, 0)).toEqual([]);
    ui.renderer.destroy();
    await ui.renderer.closed;
    expect(locateHeadings(markdown, 0)).toEqual([]);
  } finally {
    await ui.dispose();
  }
});
