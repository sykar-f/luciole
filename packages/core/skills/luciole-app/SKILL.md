---
name: luciole-app
description: Luciole app features. Use when adding or changing a screen of a luciole app (@luciole-sh/core), such as a route, page, layout, loading, error or not-found screen, or a dynamic route under app/; when writing a Server Function ("use server", actions/) or reading data on the Server (server/, "use cache"); when a page must update after a change (invalidate, cache tags, "the list does not refresh"); when navigating between screens (useNavigate, params, search params); when adding sign-in, a public page or per-user data (server/auth.ts, getSession); when typed text must survive a crash or a rebuild (named fields, session restore). Phrasings such as "add a page", "add a screen at /x", "add a button that saves", "show the count of", "make it refresh", "add login".
---

# Build a feature in a luciole app

A luciole app is one codebase built into two programs: the **Server** renders pages and runs
Server Functions next to the data; the **Client** draws the terminal and handles every key.
The docs of the installed version start at `node_modules/@luciole-sh/core/docs/README.md`;
this file holds what you would get wrong without them.

## Where each piece goes

| File                                                   | Side   | First line              | Holds                                                            |
| ------------------------------------------------------ | ------ | ----------------------- | ---------------------------------------------------------------- |
| `app/<path>/page.tsx`                                  | Server | none                    | An `async` default export: reads data, renders Client Components |
| `app/<path>/layout.tsx`                                | Client | `"use client"`          | Wraps every page below it, stays mounted across them             |
| `app/<path>/loading.tsx`, `error.tsx`, `not-found.tsx` | Client | `"use client"`          | The page's slot while it loads, fails, or calls `notFound()`     |
| `actions/*.ts`                                         | Server | `"use server"`          | Server Functions the Client calls                                |
| `server/*.ts`                                          | Server | `import "server-only";` | Data access, cached reads (`"use cache"`), tags                  |
| `components/*.tsx`                                     | Client | `"use client"`          | Anything with state, effects, keys or `onPress`                  |

## Add a screen, end to end

1. **Route.** Create `app/stats/page.tsx`. `[id]` is a param, `(group)` adds no segment,
   `[...rest]` catches the rest of the path.
2. **Read the data in the page**, from `server/`. Pass the user as an argument to the cached
   read; never call `getSession()` inside it:

   ```tsx
   import { getSession, notFound } from "@luciole-sh/core/server";
   import { getOperation, saveNote } from "../../../actions/notes";
   import { NoteEditor } from "../../../components/NoteEditor";
   import { noteOf } from "../../../server/queries";

   export default async function Page({ params }: { params: { id: string } }) {
     const note = await noteOf(getSession().userId, params.id);
     if (!note) notFound("Note");
     return (
       <NoteEditor
         initialNote={note}
         saveAction={saveNote}
         resolveAction={getOperation}
         autosaveMs={1000}
       />
     );
   }
   ```

3. **Put the interactive part in a Client Component** (`"use client"`) and give it data and
   Server Functions as props, or let it import `actions/*` directly.
4. **Write the change as a Server Function** in `actions/`: a named
   `export async function`, its arguments validated with Zod, a value returned, then
   `invalidate` for what it changed:

   ```ts
   "use server";
   import { getSession, invalidate } from "@luciole-sh/core/server";
   import type { Note } from "../components/draft";
   import { rename } from "../server/repository";
   import { NoteId, Title } from "../server/schemas";
   import { noteTag, notesTag } from "../server/tags";

   export async function renameNote(id: string, title: string): Promise<Note> {
     const note = rename(NoteId.parse(id), Title.parse(title));
     const owner = getSession().userId;
     await Promise.all([
       invalidate({ tag: notesTag(owner) }),
       invalidate({ tag: noteTag(owner, note.id) }),
     ]);
     return note;
   }
   ```

5. **Navigate** with the route's pattern and its params, from a Client Component:
   `const navigate = useNavigate(); void navigate({ to: "/notes/$id", params: { id } });`
   (`useNavigate` from `@luciole-sh/core/client`).
6. **Check.** `bun run build` once after adding or moving a page, so `app/routeTree.gen.ts`
   knows the new route before the type check; then `bun run format` and `bun run verify`.

## Gotchas

- Layouts are Client Components: start every `layout.tsx`, `loading.tsx`, `error.tsx` and
  `not-found.tsx` with `"use client"`. A layout that needs Server data calls a Server
  Function, or receives it from a page; it cannot call `getSession()`.
- Keep pages stateless: state, effects, context, key bindings and handlers go in a Client
  Component the page renders.
- Refresh by declaring the change: a Server Function that changes data calls `invalidate()`
  (every route), `invalidate("/path")`, or `invalidate({ tag })` for each tag its change
  touches. Nothing reloads otherwise. Data a layout or a component reads through a Server
  Function reloads with `useInvalidation(() => …)`.
- A cached read stays stale until one of its tags is invalidated: tag a new cached read with
  the tags the existing Server Functions already invalidate, or add its tag to them.
- Call `getSession()` in the page or the Server Function, then pass `userId` into the
  `"use cache"` function: `getSession()` throws inside one.
- A Server Function returns a value (`Promise<number>`, the id it changed): the Client
  refuses one that returns nothing.
- Exports of a `"use server"` module are named `async function` declarations, plus
  `export const auth = "public" as const` when the module is public. No arrow functions,
  no default export, no re-exports.
- Read params and search params as strings, and parse them (`z.coerce.number()`). Use
  `[...rest]` or two pages for an optional segment: `[[...x]]` does not exist.
- Leave `app/routeTree.gen.ts` to the build and commit it with the route.
- Mark Server-only modules `import "server-only";` and modules that must run on the user's
  machine (`$EDITOR`, clipboard, `~/.config`) `import "client-only";`.
- Import with relative paths and static `import` statements: tsconfig path aliases,
  `require()` and dynamic `import()` fail the build.
- Run the Client and the Server from the same build: a Server of another build answers
  `409` ("Incompatible build"); rebuild and restart both.
- `<Input>` reports typing through `onInput`; `<Textarea>` through `onChange`.

## Read further when the task needs it

- Read [references/routing.md](references/routing.md) when adding a dynamic route, a route
  group, a layout, search params or a navigation.
- Read [references/server-functions.md](references/server-functions.md) when writing a
  Server Function or handling a failed call.
- Read [references/cache.md](references/cache.md) when a page reads data that changes, or
  when a change does not show.
- Read [references/auth.md](references/auth.md) when adding sign-in, a public page or a
  public Server Function, or per-user data.
- Read [references/loading-errors.md](references/loading-errors.md) when adding a loading,
  error or not-found screen, or showing the connection's state.
- Read [references/session-restore.md](references/session-restore.md) when typed text must
  survive a crash, a rebuild or going back.

## Other skills

- Terminal rendering, layout of boxes and key bindings: `luciole-tui`.
- Tests of the app (`@luciole-sh/core/test`): `luciole-test`.
- A failure to diagnose (a `401`, a `409`, a blank screen, a build error): `luciole-debug`.
