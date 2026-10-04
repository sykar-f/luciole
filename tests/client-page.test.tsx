/** @jsxImportSource @opentui/react */
import { expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "../packages/core/src/build";
import {
  BUILD_TEST_MS,
  destroy,
  importClient,
  launch,
  readManifest,
  untilFrame,
  type TestUI,
} from "./helpers";

// concepts/server-components.mdx: pages are Server by default, and the build does not
// refuse a "use client" page. Such a page is a Client Component like any other.
test(
  'a "use client" page builds as a Client Reference and the Client draws it',
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "luciole-client-page-"));
    let server: Awaited<ReturnType<typeof launch>> | undefined, rendered: TestUI | undefined;
    try {
      await mkdir(join(directory, "app"), { recursive: true });
      await symlink(resolve("node_modules"), join(directory, "node_modules"), "dir");
      await Bun.write(
        join(directory, "app/layout.tsx"),
        `"use client";export default function Layout({children}){return <box>{children}</box>}`,
      );
      await Bun.write(
        join(directory, "app/page.tsx"),
        `"use client";\nimport { useState } from "react";\nexport default function Page() {\n  const [text] = useState("CLIENT_PAGE_SENTINEL");\n  return <text>{text}</text>;\n}\n`,
      );
      await build(directory);
      const manifest = await readManifest(directory);
      expect(manifest.manifest[`${manifest.buildId}/app/page.tsx#default`]).toBeDefined();
      // Its code is the Client's; the Server only holds its reference.
      expect(await Bun.file(join(directory, ".luciole/client/index.js")).text()).toContain(
        "CLIENT_PAGE_SENTINEL",
      );
      expect(await Bun.file(join(directory, ".luciole/server/index.js")).text()).not.toContain(
        "CLIENT_PAGE_SENTINEL",
      );

      server = await launch(join(directory, ".luciole/server/index.js"));
      const { createApp, Shell } = await importClient(directory);
      const app = createApp({ url: server.url });
      await app.router.load();
      rendered = await testRender(<Shell app={app} />, { width: 40, height: 5 });
      await untilFrame(rendered, "CLIENT_PAGE_SENTINEL");
    } finally {
      await destroy(rendered);
      if (server) await server.stop();
      await rm(directory, { recursive: true, force: true });
    }
  },
  BUILD_TEST_MS,
);
