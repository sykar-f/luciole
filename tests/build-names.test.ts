import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { build } from "../src/build";
import { annotateNames, routeComponentName } from "../src/build-names";
import { importClient } from "./helpers";

const runtime = "/fw/devtools/annotate.ts";
const annotated = (text: string, relative = "components/X.tsx") =>
  annotateNames(text, { path: `/app/${relative}`, relative, runtime });
/** The `__airttyAnnotate(...)` calls appended, as [ref, name, source, hooks] source text. */
const calls = (out: string) =>
  [...out.matchAll(/try\{__airttyAnnotate\((.*)\)\}catch\{\}/g)].map((m) => m[1]);

test("route files get a name from their route when theirs is absent or generic", () => {
  expect(routeComponentName("app/notes/[id]/page.tsx")).toBe("NotesIdPage");
  expect(routeComponentName("app/page.tsx")).toBe("HomePage");
  expect(routeComponentName("app/layout.tsx")).toBe("RootLayout");
  expect(routeComponentName("app/(auth)/sign-in/[...rest]/not-found.tsx")).toBe(
    "SignInRestNotFound",
  );
  expect(routeComponentName("components/page.tsx")).toBe(undefined);

  const page = annotated(
    "export default function Page() {\n  return null;\n}\n",
    "app/notes/[id]/page.tsx",
  );
  expect(calls(page)).toEqual(['Page,"NotesIdPage","app/notes/[id]/page.tsx:1",[]']);
  // An author's own name stays.
  const named = annotated("export default function NoteScreen() { return null }", "app/page.tsx");
  expect(calls(named)[0]).toStartWith('NoteScreen,"NoteScreen"');
});

test("anonymous default exports are named without moving a line", () => {
  const fn = annotated("\n\nexport default function () {\n  return null;\n}\n", "app/layout.tsx");
  expect(fn.split("\n")[2]).toBe("export default function __airttyDefault () {");
  expect(calls(fn)).toEqual(['__airttyDefault,"RootLayout","app/layout.tsx:3",[]']);
  const arrow = annotated("export default memo(() => null);\n", "components/note-list.tsx");
  expect(arrow.split("\n")[0]).toBe("const __airttyDefault = memo(() => null);");
  expect(arrow).toContain("export default __airttyDefault;");
  expect(calls(arrow)).toEqual(['__airttyDefault,"NoteList","components/note-list.tsx:1",[]']);
});

test("hook calls are recorded in evaluation order with the variable they feed", () => {
  const out = annotated(`import { useState, useRef } from "react";
import { useDraft } from "./draft";
function useLocal() { const [open] = useState(false); return open; }
export function Editor() {
  const [draft, setDraft] = useState("");
  const { save, edit } = useDraft(useLocal());
  const input = useRef(null);
  useEffect(() => { const [x] = useState(0); }, []);
  return null;
}
const helper = () => useState(1);
`);
  expect(calls(out)).toEqual([
    'useLocal,null,"components/X.tsx:3",[["useState","useState","open"]]',
    // useLocal() runs before useDraft(): its argument. Custom hooks the module can refer
    // to are passed as values, React's own by name; the effect's callback is not the body.
    'Editor,"Editor","components/X.tsx:4",[["useState","useState","draft"],[useLocal,"useLocal",null],[useDraft,"useDraft","save, edit"],["useRef","useRef","input"],["useEffect","useEffect",null]]',
  ]);
  expect(out).toContain(`import {annotate as __airttyAnnotate} from "${runtime}";`);
  // Nothing to annotate, nothing changes.
  expect(annotated("export const x = 1;\n")).toBe("export const x = 1;\n");
});

// Inside the checkout so `airtty` and its packages resolve like in an example.
test("a built Client names its components and records their source and hooks", async () => {
  const dir = await mkdtemp(join(resolve("."), ".build-names-"));
  try {
    const files: Record<string, string> = {
      "app/layout.tsx": `"use client";\nimport type { LayoutProps } from "airtty/client";\nexport default function Layout({ children }: LayoutProps) {\n  return <box>{children}</box>;\n}\n`,
      "app/page.tsx": `import { Boom } from "../components/Boom";\nexport default function Page() {\n  return <Boom />;\n}\n`,
      "components/Boom.tsx": `"use client";\nimport { useState } from "react";\n\ntype Props = { label?: string };\n\nexport function Boom(_props: Props) {\n  const [count] = useState(0);\n  return <text>{count}</text>;\n}\nexport function explode(): never {\n  throw new Error("boom");\n}\n`,
    };
    for (const [name, text] of Object.entries(files)) {
      await mkdir(join(dir, name, ".."), { recursive: true });
      await Bun.write(join(dir, name), text);
    }
    const { buildId } = await build(dir);
    const client = await importClient(dir, "build-names");
    const app = client.createApp({ url: "http://terminal.invalid" });
    const boom = app.options.resolveModule(`${buildId}/components/Boom.tsx`);
    expect(boom.Boom).toMatchObject({ displayName: "Boom" });
    const { Boom } = boom;
    expect(Object.getOwnPropertyDescriptor(Boom, "__airtty")?.value).toEqual({
      source: "components/Boom.tsx:6",
      hooks: [["useState", "useState", "count"]],
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 60_000);
