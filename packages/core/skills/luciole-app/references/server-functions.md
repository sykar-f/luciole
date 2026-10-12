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

For an aggregate, pass `{ initial, reduce: (state, item) => nextState }` and read
`{ state, done, error }`: no `items` array is retained. Return immutable state. New
arguments reset to the current initial value; reducer/initial changes alone do not
restart. A thrown reducer ends the stream with `done` and `error`.

When reconnecting from a cursor, read the “Fold items and reconnect from a cursor”
section in the Server Functions rules linked above. Keep the last cursor in folded
state, retry on `done` with or without `error`, use a capped backoff and change an
`attempt` argument. Carry the folded state into the next `initial`; the Server must
replay strictly after its cursor. Clear the retry timer on unmount. Replay retention
and duplicate handling belong to the app.

For a generator waiting on a subscription's queue, capture `getSignal()` from
`@luciole-sh/core/server` inside the Server Function. Await the queue's wake promise with
`abortable(promise, signal)`; catch the rejection only when `signal.aborted`, and release
the subscription in `finally`. The helper rejects with `signal.reason` while the source
promise continues. Pass the signal directly to external APIs that accept it. A periodic
beat is no longer needed: the Server closes the response on cancel even when a generator
ignores the signal, but its `finally` needs an interruptible await to run promptly.

The full queue example is in the live section of the Server Functions rules linked above.
