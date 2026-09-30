/**
 * What the scripted generator (server/generator.ts) writes for a few prompts: a first
 * attempt, and for the attempts that fail, the correction a harness would make after
 * reading studio's diagnostics. Taken from probes/studio-generate: the faults are the
 * ones code models commonly make in a React/TypeScript codebase they do not know. No
 * model is called: every real prompt spends the user's quota (docs/CODER-HANDOFF.md §3).
 */
export type Turn = Record<string, string>;
export type Scenario = {
  name: string;
  /** Words of a prompt that pick this scenario. */
  match: RegExp;
  prompt: string;
  /** What the generator says before writing. */
  reply: string;
  /** The first attempt, then corrections, one per studio correction message. */
  turns: Turn[];
  /**
   * Writes the first attempt makes before its own files, one after the other, as an agent
   * writes a file per tool call: studio shows each one as a draft. Each builds.
   */
  drafts?: Turn[];
  /** The scenario whose files this one starts from (its first turn, written before). */
  after?: string;
  /** The stage its first attempt fails at (`ok`: it passes): tests check it. */
  expected: "ok" | "guard" | "build" | "types" | "render";
  /** A command the generator asks to run first (studio's policy refuses it). */
  command?: string;
};

const counterPage = (extra = "") => `import { Counter } from "../components/Counter";
import { increment } from "../actions/counter";
import { greeting } from "../server/greeting";
import { count } from "../server/store";

export default function Page() {
  return (
    <box flexDirection="column" gap={1}>
      <text id="studio-greeting">{greeting}</text>
      <Counter initial={count()} increment={increment} />${extra}
    </box>
  );
}
`;

const todoStore = `export type Todo = { id: number; title: string; done: boolean };
const todos: Todo[] = [
  { id: 1, title: "Try studio", done: true },
  { id: 2, title: "Generate an app", done: false },
];
export const list = () => todos;
export function toggle(id: number) {
  const todo = todos.find((t) => t.id === id);
  if (todo) todo.done = !todo.done;
  return todos;
}
`;
const todoAction = `"use server";
import { z } from "zod";
import { toggle } from "../server/todos";

export async function toggleTodo(id: number) {
  return toggle(z.number().int().parse(id));
}
`;
const todoList = (body: string) => `"use client";
import { useState } from "react";
import { useBindings } from "luciole/client";
import type { Todo } from "../server/todos";

export function TodoList({
  initial,
  toggle,
}: {
  initial: Todo[];
  toggle: (id: number) => Promise<Todo[]>;
}) {
  const [todos, setTodos] = useState(initial);
  const [cursor, setCursor] = useState(0);
  useBindings(
    () => ({
      bindings: [
        { key: "j", cmd: () => setCursor((c) => Math.min(c + 1, todos.length - 1)) },
        { key: "k", cmd: () => setCursor((c) => Math.max(c - 1, 0)) },
        { key: "space", cmd: () => void toggle(todos[cursor]?.id ?? -1).then(setTodos) },
      ],
    }),
    [todos, cursor, toggle],
  );
${body}
}
`;
const todoListBody = `  return (
    <box flexDirection="column">
      {todos.map((todo, i) => (
        <text key={todo.id} fg={i === cursor ? "#67d9bc" : "#e6edf3"}>
          {todo.done ? "[x]" : "[ ]"} {todo.title}
        </text>
      ))}
    </box>
  );`;
const todoPage = `import { TodoList } from "../../components/TodoList";
import { toggleTodo } from "../../actions/todos";
import { list } from "../../server/todos";

export default function TodosPage() {
  return <TodoList initial={list()} toggle={toggleTodo} />;
}
`;

const guestbookStore = `import { join } from "node:path";
import { Database } from "bun:sqlite";

// The signatures live in data/, beside the counter: they survive every change of the code.
const db = new Database(join(process.env.STUDIO_DATA ?? ".", "guestbook.sqlite"));
db.run(
  "CREATE TABLE IF NOT EXISTS entries (id INTEGER PRIMARY KEY, name TEXT NOT NULL, message TEXT NOT NULL)",
);
const GUESTS = 30;
if (!db.query("SELECT 1 FROM entries LIMIT 1").get())
  for (let i = 1; i <= GUESTS; i++)
    db.run("INSERT INTO entries (name, message) VALUES (?, ?)", [
      \`Guest \${String(i).padStart(2, "0")}\`,
      "Hello from the first visitors",
    ]);

export type Entry = { id: number; name: string; message: string };
export const entries = (): Entry[] =>
  db.query<Entry, []>("SELECT id, name, message FROM entries ORDER BY id").all();
export function sign(name: string, message: string): Entry[] {
  db.run("INSERT INTO entries (name, message) VALUES (?, ?)", [name, message]);
  return entries();
}
`;
const guestbookAction = `"use server";
import { z } from "zod";
import { sign } from "../server/guestbook";

const Name = z.string().trim().min(1).max(40);
const Message = z.string().trim().min(1).max(200);
export async function signGuestbook(name: string, message: string) {
  return sign(Name.parse(name), Message.parse(message));
}
`;
/** The guestbook: its entries in a named scroll box, a form of two named fields. */
const guestbook = (title: string) => `"use client";
import { useRef, useState } from "react";
import type { ScrollBoxRenderable } from "@opentui/core";
import { Input, ScrollBox, useBindings, useRestoredFields, useRestoredFocus } from "luciole/client";
import type { Entry } from "../server/guestbook";

const FIELDS = ["guestbook/name", "guestbook/message"] as const;
const PAGE = 5;

export function Guestbook({
  initial,
  sign,
}: {
  initial: Entry[];
  sign: (name: string, message: string) => Promise<Entry[]>;
}) {
  const [entries, setEntries] = useState(initial);
  const [name, setName] = useState("");
  const [message, setMessage] = useState("");
  // Named fields, their focus and the list's position come back after every change.
  const [focus, setFocus] = useRestoredFocus(FIELDS);
  const fields = useRestoredFields("guestbook");
  const list = useRef<ScrollBoxRenderable>(null);
  const submit = () => {
    if (!name.trim() || !message.trim()) return;
    void fields.submit(() => sign(name, message)).then((next) => {
      setEntries(next);
      setMessage("");
    });
  };
  useBindings(
    () => ({
      bindings: [
        {
          key: "tab",
          cmd: () => setFocus((f) => (f === FIELDS[0] ? FIELDS[1] : FIELDS[0])),
          desc: "next field",
        },
        { key: "pagedown", cmd: () => list.current?.scrollBy(PAGE), desc: "scroll" },
        { key: "pageup", cmd: () => list.current?.scrollBy(-PAGE) },
      ],
    }),
    [setFocus],
  );
  return (
    <box flexDirection="column" gap={1}>
      <text id="guestbook-title" fg="#67d9bc">
        ${title}
      </text>
      <ScrollBox id="guestbook-entries" name="guestbook/entries" ref={list} height={6} scrollY>
        {entries.map((entry) => (
          <text key={entry.id}>{\`\${entry.name}: \${entry.message}\`}</text>
        ))}
      </ScrollBox>
      <box flexDirection="row" gap={1} height={1}>
        <text width={8}>Name</text>
        <Input
          name="guestbook/name"
          focused={focus === "guestbook/name"}
          value={name}
          onInput={setName}
          onSubmit={submit}
          placeholder="Your name"
          flexGrow={1}
        />
      </box>
      <box flexDirection="row" gap={1} height={1}>
        <text width={8}>Message</text>
        <Input
          name="guestbook/message"
          focused={focus === "guestbook/message"}
          value={message}
          onInput={setMessage}
          onSubmit={submit}
          placeholder="Enter signs"
          flexGrow={1}
        />
      </box>
    </box>
  );
}
`;
const guestbookPage = `import { Guestbook } from "../../components/Guestbook";
import { signGuestbook } from "../../actions/guestbook";
import { entries } from "../../server/guestbook";

export default function GuestbookPage() {
  return <Guestbook initial={entries()} sign={signGuestbook} />;
}
`;
const links = `"use client";
import { useBindings, useNavigate } from "luciole/client";

export function Links() {
  const navigate = useNavigate();
  useBindings(
    () => ({
      bindings: [{ key: "g", cmd: () => void navigate({ to: "/guestbook" }), desc: "guestbook" }],
    }),
    [navigate],
  );
  return <text id="studio-links">g: the guestbook</text>;
}
`;

export const SCENARIOS: Scenario[] = [
  {
    name: "greeting",
    match: /\bgreeting to\b/i,
    reply: "Changing the greeting in server/greeting.ts.",
    prompt: "Change the greeting to 'Hello from studio'",
    expected: "ok",
    turns: [{ "server/greeting.ts": `export const greeting = "Hello from studio";\n` }],
  },
  {
    name: "todo",
    match: /\/todos\b/i,
    reply: "A /todos page: a store in server/, an action, a list component.",
    prompt: "Add a /todos page with a list I can move through with j/k and toggle with space",
    expected: "ok",
    turns: [
      {
        "server/todos.ts": todoStore,
        "actions/todos.ts": todoAction,
        "components/TodoList.tsx": todoList(todoListBody),
        "app/todos/page.tsx": todoPage,
      },
    ],
  },
  {
    name: "syntax",
    match: /\bbold\b/i,
    reply: "Making the count bold on the home page.",
    prompt: "Show the count in bold",
    expected: "build",
    turns: [
      {
        "app/page.tsx": counterPage().replace(
          '<text id="studio-greeting">{greeting}</text>',
          '<text id="studio-greeting">{greeting}',
        ),
      },
      { "app/page.tsx": counterPage("\n      <text attributes={1}>bold</text>") },
    ],
  },
  {
    name: "invented-import",
    match: /\bheader\b/i,
    reply: "Adding a header to the home page.",
    prompt: "Add a header component",
    expected: "build",
    turns: [
      {
        "app/page.tsx": `import { Header } from "../components/Header";\n${counterPage("\n      <Header />")}`,
      },
      {
        "components/Header.tsx": `export function Header() {\n  return <text fg="#67d9bc">My app</text>;\n}\n`,
        "app/page.tsx": `import { Header } from "../components/Header";\n${counterPage("\n      <Header />")}`,
      },
    ],
  },
  {
    name: "hook-in-server-component",
    match: /\bmy name\b|\btype my name\b/i,
    reply: "A field for the name, right in the page.",
    prompt: "Let me type my name on the home page",
    // The build refuses Client-only React in a Server Component.
    expected: "build",
    turns: [
      {
        "app/page.tsx": `import { useState } from "react";\n\nexport default function Page() {\n  const [name, setName] = useState("");\n  return <input focused value={name} onInput={setName} placeholder="Your name" />;\n}\n`,
      },
      {
        "components/Name.tsx": `"use client";\nimport { useState } from "react";\n\nexport function Name() {\n  const [name, setName] = useState("");\n  return <input focused value={name} onInput={setName} placeholder="Your name" />;\n}\n`,
        "app/page.tsx": `import { Name } from "../components/Name";\n\nexport default function Page() {\n  return <Name />;\n}\n`,
      },
    ],
  },
  {
    name: "wrong-type",
    match: /\bstart\b.*\b10\b/i,
    reply: "Starting the counter at 10.",
    prompt: "Start the counter at 10",
    expected: "types",
    turns: [
      { "app/page.tsx": counterPage().replace("initial={count()}", 'initial="10"') },
      { "app/page.tsx": counterPage().replace("initial={count()}", "initial={10}") },
    ],
  },
  {
    name: "wrong-prop",
    match: /\bred\b/i,
    reply: "Coloring the greeting red.",
    prompt: "Make the greeting red",
    expected: "types",
    turns: [
      {
        "app/page.tsx": counterPage().replace(
          '<text id="studio-greeting">',
          '<text id="studio-greeting" color="red">',
        ),
      },
      {
        "app/page.tsx": counterPage().replace(
          '<text id="studio-greeting">',
          '<text id="studio-greeting" fg="#ff6b6b">',
        ),
      },
    ],
  },
  {
    name: "server-crash",
    match: /\bfirst todo\b/i,
    reply: "Showing the first todo on the home page.",
    prompt: "Show the first todo's title on the home page",
    expected: "render",
    turns: [
      {
        "server/todos.ts": todoStore.replace(
          'const todos: Todo[] = [\n  { id: 1, title: "Try studio", done: true },\n  { id: 2, title: "Generate an app", done: false },\n];',
          "const todos: Todo[] = [];",
        ),
        "app/page.tsx": `import { list } from "../server/todos";\n\nexport default function Page() {\n  const first = list()[0];\n  if (!first) throw new Error("no todo to show");\n  return <text>{first.title}</text>;\n}\n`,
      },
      {
        "app/page.tsx": `import { list } from "../server/todos";\n\nexport default function Page() {\n  const first = list()[0];\n  return <text>{first ? first.title : "No todo yet"}</text>;\n}\n`,
      },
    ],
  },
  {
    name: "client-crash",
    match: /\btodo count\b/i,
    reply: "Counting the todos in the list.",
    prompt: "Show the todo count in the list",
    expected: "render",
    turns: [
      {
        "server/todos.ts": todoStore,
        "actions/todos.ts": todoAction,
        "components/TodoList.tsx": todoList(
          todoListBody.replace(
            '<box flexDirection="column">',
            '<box flexDirection="column">\n      <text>{JSON.parse("").length} todos</text>',
          ),
        ),
        "app/page.tsx": todoPage.replaceAll("../../", "../"),
      },
      {
        "components/TodoList.tsx": todoList(
          todoListBody.replace(
            '<box flexDirection="column">',
            '<box flexDirection="column">\n      <text>{todos.length} todos</text>',
          ),
        ),
      },
    ],
  },
  {
    name: "unknown-package",
    match: /\bseparators?\b|\bthousands\b/i,
    reply: "Formatting numbers with numeral.",
    prompt: "Format the count with thousands separators",
    expected: "guard",
    turns: [
      {
        "components/Format.tsx": `"use client";\nimport numeral from "numeral";\n\nexport function Format({ value }: { value: number }) {\n  return <text>{numeral(value).format("0,0")}</text>;\n}\n`,
      },
      {
        "components/Format.tsx": `"use client";\n\nexport function Format({ value }: { value: number }) {\n  return <text>{value.toLocaleString("en-US")}</text>;\n}\n`,
      },
    ],
  },
  {
    name: "shell-out",
    match: /\bgit branch\b/i,
    reply: "Reading the branch with git.",
    prompt: "Show the current git branch",
    expected: "guard",
    turns: [
      {
        "server/git.ts": `import { execSync } from "node:child_process";\nexport const branch = () => execSync("git branch --show-current").toString().trim();\n`,
      },
      {
        "server/git.ts": `// The app has no exec capability: studio would ask the user to grant it.\nexport const branch = () => "unknown";\n`,
      },
    ],
  },
  {
    name: "dependency",
    match: /\bcharts?\b/i,
    reply: "Adding a chart library to package.json.",
    prompt: "Add charts",
    expected: "guard",
    turns: [
      { "package.json": `{"name":"studio-app","dependencies":{"asciichart":"1.5.25"}}` },
      {
        "components/Bars.tsx": `export function Bars({ values }: { values: number[] }) {\n  return <text>{values.map((v) => "▇".repeat(v)).join("\\n")}</text>;\n}\n`,
      },
    ],
  },
  {
    name: "command",
    match: /\brun\b.*\btests?\b|\bnpm\b|\bbun (add|install)\b/i,
    reply: "Running the tests first.",
    prompt: "Run the tests",
    expected: "ok",
    command: "bun test",
    turns: [
      { "server/greeting.ts": `export const greeting = "Tests? studio checks the app itself.";\n` },
    ],
  },
  {
    name: "guestbook",
    match: /\bguestbook page\b/i,
    reply: "A guestbook: a store in server/, an action, a form, its page, then a link home.",
    prompt: "Add a guestbook page with a form to sign it",
    expected: "ok",
    // Four writes, as an agent makes them: the preview follows each one.
    drafts: [
      {
        "app/page.tsx": counterPage('\n      <text id="studio-soon">A guestbook is coming…</text>'),
      },
      { "server/guestbook.ts": guestbookStore, "actions/guestbook.ts": guestbookAction },
      {
        "components/Guestbook.tsx": guestbook("Guestbook"),
        "app/guestbook/page.tsx": guestbookPage,
      },
    ],
    turns: [
      {
        "components/Links.tsx": links,
        "app/page.tsx": `import { Links } from "../components/Links";\n${counterPage("\n      <Links />")}`,
      },
    ],
  },
  {
    name: "signatures",
    match: /\bsigned the guestbook\b/i,
    reply: "Counting the signatures in the guestbook's title.",
    prompt: "Show how many people signed the guestbook",
    expected: "ok",
    after: "guestbook",
    drafts: [{ "components/Guestbook.tsx": guestbook("Guestbook · counting signatures…") }],
    turns: [{ "components/Guestbook.tsx": guestbook("Guestbook · {entries.length} signatures") }],
  },
];

/** The files `scenario` starts from: those of the scenario it continues, as written. */
export function startingPoint(scenario: Scenario): Turn {
  if (!scenario.after) return {};
  const before = SCENARIOS.find((s) => s.name === scenario.after);
  if (!before?.turns[0]) throw new Error(`${scenario.name} continues an unknown scenario`);
  const files: Turn = {};
  for (const turn of [...(before.drafts ?? []), before.turns[0]]) Object.assign(files, turn);
  return files;
}
