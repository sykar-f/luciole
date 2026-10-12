import { expect, test } from "bun:test";
import { definedProperties } from "../packages/core/src/defined-properties";
import { compileRouteGraph, renderRouteTree } from "../packages/core/src/route-graph";

test("strict options omit undefined while keeping falsy values", () => {
  const options = { absent: undefined, zero: 0, empty: "", disabled: false, nullable: null };
  expect(definedProperties(options)).toEqual({
    zero: 0,
    empty: "",
    disabled: false,
    nullable: null,
  });
  expect(Object.hasOwn(options, "absent")).toBe(true);
});

test("strict consumer uses the generator's nested layout tree", async () => {
  const graph = compileRouteGraph([
    "app/layout.tsx",
    "app/nested/layout.tsx",
    "app/nested/page.tsx",
  ]);
  const source = renderRouteTree(graph);
  expect(source).toContain("  layoutRoute,");
  expect(source).toContain("...layoutRoute(");
  expect(await Bun.file("tests/fixtures/strict-consumer/app/routeTree.gen.ts").text()).toBe(source);
});

test("flat route trees import only the helpers they use", () => {
  const source = renderRouteTree(compileRouteGraph(["app/layout.tsx", "app/page.tsx"]));
  expect(source).not.toContain("layoutRoute");
  expect(source).toContain("loadPage(");
  expect(source).toContain("pageRoute(");
});
