# Loading, errors and not found

The full rules: `node_modules/@luciole-sh/core/docs/concepts/loading-and-errors.md`.

Each of these files starts with `"use client"`, has a default export, and replaces only the
page's slot: the layouts around it stay mounted. A page takes the nearest one among its
parent directories.

| File            | Props (`@luciole-sh/core/client`)              | Shown                                    |
| --------------- | ---------------------------------------------- | ---------------------------------------- |
| `loading.tsx`   | `LoadingProps`: `{ params }`                   | At once, until the page arrives          |
| `error.tsx`     | `ErrorProps`: `{ error, path, params, retry }` | When loading or rendering the page fails |
| `not-found.tsx` | `{ path, params, what }`                       | When the page calls `notFound(what?)`    |

- `notFound("Note")` from `@luciole-sh/core/server` ends the page's render; TypeScript
  narrows after it. `app/not-found.tsx` also answers a URL no page matches.
- A loading screen cannot wait for Server data. Draw it with what the Client already has
  (the starter's reads the title from the sidebar's list) and in the page's shape, so the
  page does not jump when it arrives.
- `error` is a `TransportError` (check `outcome`) or a render error whose message is
  generic in production. Show your own words, and offer `retry()`.
- The layout shows the connection with `useConnection()`: `status`, `error`, `buildError`,
  `refresh`, `activity`. The framework draws no status bar.
