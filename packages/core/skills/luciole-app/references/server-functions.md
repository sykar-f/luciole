# Server Functions

The full rules: `node_modules/@luciole-sh/core/docs/concepts/server-functions.md`.

## Shape of a module

```ts
"use server";
import { getSession, invalidate } from "@luciole-sh/core/server";
import { z } from "zod";
import { remove } from "../server/repository";
import { noteTag, notesTag } from "../server/tags";

const NoteId = z.string().min(1);

/** Answers the deleted note's id: a Server Function returning nothing is refused by the Client. */
export async function deleteNote(id: string): Promise<string> {
  const note = NoteId.parse(id);
  remove(note);
  const owner = getSession().userId;
  await Promise.all([
    invalidate({ tag: notesTag(owner) }),
    invalidate({ tag: noteTag(owner, note) }),
  ]);
  return note;
}
```

- Validate every argument with Zod before any effect: the TypeScript type is what the Client
  should send, not what arrives. A failed parse reaches the caller as a generic `500`.
- `await` each `invalidate`: the Server answers once the purges are done, so the reload reads
  the new data.
- All the functions of a module share its `auth`. Put public ones (a sign-in) in a module of
  their own with `export const auth = "public" as const;`.
- Pass a Server Function to a Client Component as a prop from the page, or import the module
  from the Client Component. Both call it the same way; never pass one to another Server
  Function or `.bind` it.
- Cache the reads a Server Function calls (`server/queries.ts`), never the Server Function.

## When a call fails

A failed call throws a `TransportError`: `not-sent` and `rejected` mean the function did not
run, `unknown` that it may have.

```tsx
"use client";
import { TransportError } from "@luciole-sh/core/client";

/** Whether a failed call surely did not run, so sending it again cannot apply it twice. */
export function didNotRun(error: unknown): boolean {
  return error instanceof TransportError && error.outcome !== "unknown";
}
```

The transport never retries. Decide in the app what a failed call means.

## Stream values

An `export async function*` streams; read it with
`const { items, done, error } = useLive(fn, [args])` from `@luciole-sh/core/client`. It stops
on unmount, and nothing reconnects by itself.
