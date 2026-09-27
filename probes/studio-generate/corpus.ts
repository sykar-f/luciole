/**
 * What a harness might write for a few prompts, scripted: a first attempt, and for the
 * attempts that fail, the correction a harness would make after reading the diagnostics.
 * No model is called (docs/CODER-HANDOFF.md, section 3: every real prompt spends the
 * user's quota); the faults are the ones code models commonly make in a React/TypeScript
 * codebase they do not know: a syntax slip, an invented import, a hook in a Server
 * Component, a wrong prop, a crash on data, a package the workspace does not have.
 */
export type Turn = Record<string, string>;
export type Case = {
  name: string;
  prompt: string;
  /** The first attempt, then corrections, applied in order until one validates. */
  turns: Turn[];
  /** The stage the first attempt is expected to fail at (`ok`: it should pass). */
  expected: "ok" | "guard" | "build" | "types" | "render";
  /** Where the fault is, to check that the diagnostic points at it. */
  fault?: { file: string; line: number };
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
import { useBindings } from "airtty/client";
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

export const CORPUS: Case[] = [
  {
    name: "greeting",
    prompt: "Change the greeting to 'Hello from studio'",
    expected: "ok",
    turns: [{ "server/greeting.ts": `export const greeting = "Hello from studio";\n` }],
  },
  {
    name: "todo",
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
    prompt: "Show the count in bold",
    expected: "build",
    // A <text> left open on line 9.
    fault: { file: "app/page.tsx", line: 9 },
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
    prompt: "Add a header component",
    expected: "build",
    fault: { file: "app/page.tsx", line: 1 },
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
    prompt: "Let me type my name on the home page",
    // The build lets it through: the Server fails to start (react-server has no useState).
    expected: "render",
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
    prompt: "Start the counter at 10",
    expected: "types",
    fault: { file: "app/page.tsx", line: 10 },
    turns: [
      { "app/page.tsx": counterPage().replace("initial={count()}", 'initial="10"') },
      { "app/page.tsx": counterPage().replace("initial={count()}", "initial={10}") },
    ],
  },
  {
    name: "wrong-prop",
    prompt: "Make the greeting red",
    expected: "types",
    fault: { file: "app/page.tsx", line: 9 },
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
    prompt: "Add charts",
    expected: "guard",
    turns: [
      { "package.json": `{"name":"studio-app","dependencies":{"asciichart":"1.5.25"}}` },
      {
        "components/Bars.tsx": `export function Bars({ values }: { values: number[] }) {\n  return <text>{values.map((v) => "▇".repeat(v)).join("\\n")}</text>;\n}\n`,
      },
    ],
  },
];
