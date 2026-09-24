import { test, expect } from "bun:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadAppBundle } from "../src/app-bundle";
import { build } from "../src/build";
import { CapabilityDenied, createApplication, host, type HostChannel } from "../src/client";
import { directChannel, HostRequest } from "../src/host";
import { messageOf } from "../src/guards";
import { rejectionOf } from "./helpers";

const isCall = (value: unknown): value is (text: string) => Promise<unknown> =>
  typeof value === "function";

/** A channel that records what it is asked and answers `answer`. */
function recording(answer: (request: HostRequest) => unknown = () => undefined) {
  const asked: HostRequest[] = [];
  const channel: HostChannel = {
    request: (request) => {
      asked.push(request);
      return Promise.resolve(answer(request));
    },
    state: () => "granted",
    listen: () => () => {},
  };
  return { asked, channel };
}

test("the runtime's own host is bound to no Application", async () => {
  expect(messageOf(await rejectionOf(host.clipboard.write("x")))).toContain("bound per bundle");
});

test("requests are validated before anything performs them", async () => {
  expect(HostRequest.safeParse({ type: "open-url", url: "file:///etc/passwd" }).success).toBe(
    false,
  );
  expect(HostRequest.safeParse({ type: "secret", name: "../x" }).success).toBe(false);
  expect(HostRequest.safeParse({ type: "tabs.post", message: "x".repeat(70_000) }).success).toBe(
    false,
  );
  expect(HostRequest.safeParse({ type: "notify", title: "t" }).success).toBe(true);
  // Performed directly, an invalid request is refused the same way.
  expect(
    await rejectionOf(directChannel("http://a").request({ type: "open-url", url: "javascript:x" })),
  ).toBeInstanceOf(Error);
});

test("each bundle evaluation asks through the Application it is bound to", async () => {
  const dir = await mkdtemp(join(tmpdir(), "airtty-host-"));
  try {
    for (const [name, text] of Object.entries({
      "app/layout.tsx": `"use client";export default function Layout({children}){return children}`,
      "app/page.tsx": `import {Copy} from '../components/copy'; export default function Page(){return <Copy/>}`,
      "components/copy.tsx": `"use client";import {host} from 'airtty/client';export function Copy(){return null}export const copy=(text:string)=>host.clipboard.write(text);export const secret=(name:string)=>host.secret(name);`,
    })) {
      await mkdir(join(dir, name, ".."), { recursive: true });
      await Bun.write(join(dir, name), text);
    }
    await build(dir);
    const panes = await Promise.all(
      ["one", "two"].map(async (name) => {
        const loaded = await loadAppBundle(join(dir, ".airtty/app"));
        const { asked, channel } = recording((request) =>
          request.type === "secret" ? `${name}-secret` : undefined,
        );
        const app = createApplication({
          url: "http://127.0.0.1:1",
          buildId: loaded.buildId,
          routeTree: loaded.routeTree,
          resolveModule: () => ({}),
          host: channel,
        });
        loaded.actions.bind(app);
        const module = [...loaded.modules.values()].find((m) => typeof m.copy === "function");
        const copy = module?.copy;
        const secret = module?.secret;
        if (!isCall(copy) || !isCall(secret)) throw new Error("the fixture's module is missing");
        return { name, asked, app, copy, secret };
      }),
    );
    for (const pane of panes) await pane.copy(`from ${pane.name}`);
    expect(panes.map((p) => p.asked)).toEqual([
      [{ type: "clipboard.write", text: "from one" }],
      [{ type: "clipboard.write", text: "from two" }],
    ]);
    expect(await panes[1]?.secret("token")).toBe("two-secret");
    for (const pane of panes) pane.app.dispose();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 60_000);

test("a refusal reaches the application as CapabilityDenied", async () => {
  const error = new CapabilityDenied("clipboard.read");
  expect(error.capability).toBe("clipboard.read");
  expect(error.message).toContain("clipboard.read not granted");
});
