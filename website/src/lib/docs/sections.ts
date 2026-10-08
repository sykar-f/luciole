// Plain TypeScript, with nothing of Astro in it: scripts/pack-docs.ts reads it under Bun.
// The order of the documentation: the sidebar, the overview and each page's previous and
// next links follow it. A page is an MDX file of src/content/docs, named by its path.
export interface Section {
  title: string;
  /** What the section is for, on the overview. */
  summary: string;
  pages: readonly string[];
}

export const sections: readonly Section[] = [
  {
    title: "Start",
    summary: "Run an example, change it, create your own app.",
    pages: ["getting-started"],
  },
  {
    title: "Concepts",
    summary: "What an app is made of, and which side runs each part.",
    pages: [
      "concepts/client-and-server",
      // An explanation of the starter's files: its URL stays under guides/.
      "guides/anatomy-of-an-app",
      "concepts/routing",
      "concepts/server-components",
      "concepts/client-components",
      "concepts/server-functions",
      "concepts/loading-and-errors",
      "concepts/session-restore",
      "concepts/cache",
      "concepts/authentication",
    ],
  },
  {
    title: "Guides",
    summary: "One task each, from a slow network to a machine you do not own.",
    pages: [
      "guides/latency-and-faults",
      "guides/devtools",
      "guides/opening-an-app",
      "guides/ship-a-binary",
      "guides/host-a-server",
      "guides/untrusted-apps",
      "guides/terminals-and-panes",
      "guides/testing",
      "guides/coding-agents",
    ],
  },
  {
    title: "Reference",
    summary: "Every command, field, variable and export, as the code defines them.",
    pages: [
      "reference/cli",
      "reference/app-arguments",
      "reference/package-json",
      "reference/environment",
      "reference/api",
      "reference/build-and-distribution",
      "reference/optional-packages",
      "reference/troubleshooting",
      "reference/releases",
      "reference/glossary",
    ],
  },
];

export const order: readonly string[] = sections.flatMap((section) => section.pages);
