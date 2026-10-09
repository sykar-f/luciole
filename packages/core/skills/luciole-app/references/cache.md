# Cache and invalidation

The full rules: `node_modules/@luciole-sh/core/docs/concepts/cache.md`.

## The pattern

A cached read in `server/queries.ts`, tagged by owner; a Server Function that invalidates
those tags after a change. The starter's own:

```ts
"use cache";
import { cacheTag } from "@luciole-sh/core/server";
import { findNote, listNotes } from "./repository";
import { noteTag, notesTag } from "./tags";

export async function notesOf(owner: string) {
  cacheTag(notesTag(owner));
  return listNotes(owner);
}
export async function noteOf(owner: string, id: string) {
  cacheTag(noteTag(owner, id));
  return findNote(owner, id);
}
```

- The owner is an argument. `getSession()` throws in a `"use cache"` function and in
  anything it calls, including a repository function that calls it itself.
- A new read derived from existing data (a count, a filter) reuses its tags, or calls the
  cached read that has them (`(await notesOf(owner)).length`): a cached function that calls
  another inherits its tags. Then every Server Function that already invalidates them
  refreshes it too.
- A read with a tag of its own needs that tag invalidated by **every** Server Function that
  changes its data, the existing ones included.
- Tags are visible ASCII without commas; encode free ids (`encodeURIComponent`), as
  `server/tags.ts` does.
- A memory cache empties on each restart, so on each rebuild of `luciole dev`: a stale read
  that "fixes itself" after a restart is a missing invalidation.

## Which routes reload

After an invalidation, the Client reloads the mounted routes and the cached routes that read
the tag. A page that exports `staleTime = 30` shows its cached tree for 30 s without a
request, unless an invalidation hits it. The Client cannot invalidate a tag:
`useApplication().invalidate(paths?)` takes paths.

## Data read outside a page

A layout or a component that reads through a Server Function is not a route: reload it on
each invalidation.

```tsx
"use client";
import { useEffect, useState } from "react";
import { useInvalidation } from "@luciole-sh/core/client";
import { listNotes } from "../actions/notes";

/** How many notes the user has, read again after every change a Server Function declares. */
export function useNoteCount() {
  const [count, setCount] = useState<number | null>(null);
  const load = () => void listNotes().then((notes) => setCount(notes.length));
  useEffect(load, []);
  useInvalidation(load);
  return count;
}
```

The starter's sidebar reads its list this way (`components/notes-list.ts`).
