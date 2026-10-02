import { expect, test } from "bun:test";
import { compileRouteGraph } from "../packages/core/src/route-graph";

test("nested layouts, pathless groups, index pages and inherited loading", () => {
  const graph = compileRouteGraph([
    "app/layout.tsx",
    "app/page.tsx",
    "app/loading.tsx",
    "app/(public)/login/page.tsx",
    "app/(workspace)/layout.tsx",
    "app/(workspace)/dashboard/page.tsx",
    "app/(workspace)/projects/layout.tsx",
    "app/(workspace)/projects/new/page.tsx",
    "app/(workspace)/projects/[projectId]/layout.tsx",
    "app/(workspace)/projects/[projectId]/loading.tsx",
    "app/(workspace)/projects/[projectId]/page.tsx",
    "app/(workspace)/projects/[projectId]/settings/page.tsx",
  ]);
  expect(graph.layouts).toEqual([
    { id: "(workspace)", parent: "__root__", path: undefined, file: "app/(workspace)/layout.tsx" },
    {
      id: "(workspace)/projects",
      parent: "(workspace)",
      path: "projects",
      file: "app/(workspace)/projects/layout.tsx",
    },
    {
      id: "(workspace)/projects/[projectId]",
      parent: "(workspace)/projects",
      path: "$projectId",
      file: "app/(workspace)/projects/[projectId]/layout.tsx",
    },
  ]);
  expect(graph.pages).toEqual([
    {
      id: "/",
      parent: "__root__",
      path: "/",
      url: "/",
      params: [],
      file: "app/page.tsx",
      loading: "app/loading.tsx",
      layouts: ["app/layout.tsx"],
    },
    {
      id: "/(public)/login",
      parent: "__root__",
      path: "login",
      url: "/login",
      params: [],
      file: "app/(public)/login/page.tsx",
      loading: "app/loading.tsx",
      layouts: ["app/layout.tsx"],
    },
    {
      id: "/(workspace)/dashboard",
      parent: "(workspace)",
      path: "dashboard",
      url: "/dashboard",
      params: [],
      file: "app/(workspace)/dashboard/page.tsx",
      loading: "app/loading.tsx",
      layouts: ["app/layout.tsx", "app/(workspace)/layout.tsx"],
    },
    {
      id: "/(workspace)/projects/[projectId]",
      parent: "(workspace)/projects/[projectId]",
      path: "/",
      url: "/projects/$projectId",
      params: ["projectId"],
      file: "app/(workspace)/projects/[projectId]/page.tsx",
      loading: "app/(workspace)/projects/[projectId]/loading.tsx",
      layouts: [
        "app/layout.tsx",
        "app/(workspace)/layout.tsx",
        "app/(workspace)/projects/layout.tsx",
        "app/(workspace)/projects/[projectId]/layout.tsx",
      ],
    },
    {
      id: "/(workspace)/projects/[projectId]/settings",
      parent: "(workspace)/projects/[projectId]",
      path: "settings",
      url: "/projects/$projectId/settings",
      params: ["projectId"],
      file: "app/(workspace)/projects/[projectId]/settings/page.tsx",
      loading: "app/(workspace)/projects/[projectId]/loading.tsx",
      layouts: [
        "app/layout.tsx",
        "app/(workspace)/layout.tsx",
        "app/(workspace)/projects/layout.tsx",
        "app/(workspace)/projects/[projectId]/layout.tsx",
      ],
    },
    {
      id: "/(workspace)/projects/new",
      parent: "(workspace)/projects",
      path: "new",
      url: "/projects/new",
      params: [],
      file: "app/(workspace)/projects/new/page.tsx",
      loading: "app/loading.tsx",
      layouts: [
        "app/layout.tsx",
        "app/(workspace)/layout.tsx",
        "app/(workspace)/projects/layout.tsx",
      ],
    },
  ]);
});

test("output is deterministic regardless of inventory order", () => {
  const files = ["app/layout.tsx", "app/b/page.tsx", "app/a/[id]/page.tsx", "app/page.tsx"];
  expect(compileRouteGraph([...files].reverse())).toEqual(compileRouteGraph(files));
});

for (const [name, files, message] of [
  [
    "same URL after removing groups",
    ["app/(a)/users/page.tsx", "app/(b)/users/page.tsx"],
    /app\/\(a\)\/users\/page\.tsx.*app\/\(b\)\/users\/page\.tsx/,
  ],
  [
    "equivalent dynamic patterns",
    ["app/users/[id]/page.tsx", "app/users/[slug]/page.tsx"],
    /\/users\/\$.*app\/users\/\[id\]\/page\.tsx.*app\/users\/\[slug\]\/page\.tsx/,
  ],
  ["repeated parameter", ["app/[id]/items/[id]/page.tsx"], /Repeated route parameter "id"/],
  ["empty group", ["app/()/page.tsx"], /Malformed route segment "\(\)"/],
  ["malformed parameter", ["app/[bad-name]/page.tsx"], /Malformed route segment "\[bad-name\]"/],
  ["unbalanced group", ["app/(open/page.tsx"], /Malformed route segment "\(open"/],
  ["missing root layout", ["app/page.tsx"], /app\/layout\.tsx required/],
  ["no page", ["app/layout.tsx"], /No app\/\*\*\/page\.tsx routes/],
] as const)
  test(`reject ${name}`, () => {
    expect(() =>
      compileRouteGraph(
        files[0] === "app/page.tsx" || files[0] === "app/layout.tsx"
          ? [...files]
          : ["app/layout.tsx", ...files],
      ),
    ).toThrow(message);
  });
