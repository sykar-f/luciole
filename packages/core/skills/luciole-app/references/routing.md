# Routing

- [Discover the typed Router API](#discover-the-typed-router-api)
- [Active tabs with native selection](#active-tabs-with-native-selection)
- [Navigate](#navigate)
- [Search, preload and history](#search-preload-and-history)

The full rules: `node_modules/@luciole-sh/core/docs/concepts/routing.md`.

## Discover the typed Router API

For navigation, active tabs, search, history, preload or pending UI, read
`node_modules/@luciole-sh/core/docs/reference/upstream-libraries.md`, section "TanStack Router".
The hooks are TanStack Router's, re-exported from `@luciole-sh/core/client`; import there
so they share luciole's instance and the generated `Register` types. `useRouter()` retains
those types; `useApplication().router` is widened to `AnyRouter`.

| Task                                          | Start with                                                     |
| --------------------------------------------- | -------------------------------------------------------------- |
| Navigate with checked params                  | `useNavigate`                                                  |
| Match an active section or recover its params | `useMatchRoute`; a match returns params or `false`             |
| Read current params/search in shared chrome   | `useParams({ strict: false })`, `useSearch({ strict: false })` |
| Select a location value                       | `useLocation({ select: (location) => location.pathname })`     |
| Subscribe to pending UI                       | `useRouterState({ select: (state) => state.isLoading })`       |
| Back control                                  | `useCanGoBack`, `useRouter().history.back()`                   |
| Forward, preload or events                    | `useRouter().history.forward()`, `.preloadRoute`, `.subscribe` |

Check `node_modules/@tanstack/react-router/package.json`, then root `src/index.tsx`.
Follow its exports to `src/Matches.tsx` for `useMatchRoute`, and to the hook's source
(e.g. `src/useSearch.tsx`). For router methods follow
`node_modules/@tanstack/router-core/src/router.ts` and `src/load-client.ts`.
Use the installed signatures; upstream route setup is replaced by luciole's directory
routing. With a hook's `from`, read route IDs in `app/routeTree.gen.ts`; group/layout/index
IDs can differ from navigation's `to` patterns.

## Active tabs with native selection

For `app/notes/[id]/layout.tsx`, with a page at that route and one at `info/page.tsx`,
match generated patterns to select the native widget. The callback guard also covers
`setSelectedIndex` emitting `onChange` during synchronization:

```tsx
"use client";
import { useEffect, useRef } from "react";
import type { TabSelectRenderable } from "@opentui/core";
import { useMatchRoute, useNavigate, type LayoutProps } from "@luciole-sh/core/client";

export default function NoteTabs({ children, params }: LayoutProps) {
  const navigate = useNavigate();
  const matchRoute = useMatchRoute();
  const tabs = useRef<TabSelectRenderable>(null);
  const id = params.id ?? "";
  const info = matchRoute({ to: "/notes/$id/info", params: { id }, fuzzy: true });
  const active = info ? 1 : 0;
  useEffect(() => {
    tabs.current?.setSelectedIndex(active);
  }, [active]);
  return (
    <box flexDirection="column" flexGrow={1}>
      <tab-select
        ref={tabs}
        focused
        options={[
          { name: "Note", description: "Edit note" },
          { name: "Info", description: "Note details" },
        ]}
        onChange={(index, option) => {
          if (!option || index === active) return;
          void navigate({ to: index === 1 ? "/notes/$id/info" : "/notes/$id", params: { id } });
        }}
      />
      {children}
    </box>
  );
}
```

Use `matchRoute({ to: "/notes/$id", fuzzy: true })` to recover the active note's typed
params; narrow the result against `false` before reading `id`. For pending destinations,
inspect the hook's `pending` option. For shortcut help and focus-scoped native methods,
read `luciole-tui`'s OpenTUI reference.

- A layout cannot read Server data. Give it what it shows through a Server Function it
  calls (reloaded with `useInvalidation`), or through the page.
- A `(group)` directory with a `layout.tsx` wraps a set of pages without adding a URL
  segment: Forge keeps `/login` outside its signed-in chrome this way (`(public)/login`,
  `(app)/layout.tsx`).
- A `[...rest]` catch-all is last in its path and has no layout.
- The page below a layout still needs its own `notFound()` for a missing record; the nearest
  `not-found.tsx` shows in the page's slot, with the layout around it.

## Navigate

- `to` is the route's pattern, `$param` for each `[param]`, with `params` beside it:
  `navigate({ to: "/repos/$repo/pulls/$number", params: { repo, number } })`. A path built by
  interpolation (`` `/notes/${id}` ``) is not a route the type check knows.
- `search: { state: "merged" }` passes search params. Every value arrives as a string.
- The pages read `searchParams: Record<string, string>` on the Server; `useSearch()` reads
  them in the Client. A filter that must follow each keystroke stays local state, since
  each search is a separate Server render.
- `useParams({ strict: false })` reads the current route's params from any Client Component.
- There is no `<Link>`: navigate from an `onMouseDown`, an `onPress` or a key binding.
- After a new page, `bun run build` regenerates `app/routeTree.gen.ts`; until then a
  navigation to it is a type error.

## Search, preload and history

Search values are optional strings. Parse them into app types at both the Client and
Server boundaries. Commit filters deliberately: every committed search renders a Server
page; keep immediate typing in local state. A search updater preserves unrelated keys,
and `replace: true` avoids growing history for each filter change.

```tsx
"use client";
import { z } from "zod";
import {
  useCanGoBack,
  useNavigate,
  useRouter,
  useRouterState,
  useSearch,
} from "@luciole-sh/core/client";

export function NoteControls({ id }: { id: string }) {
  const router = useRouter();
  const navigate = useNavigate();
  const canGoBack = useCanGoBack();
  const pending = useRouterState({ select: (state) => state.isLoading });
  const search = useSearch({ strict: false });
  const page = z.coerce.number().int().min(1).catch(1).parse(search.page);
  const destination = { to: "/notes/$id", params: { id }, search: { page: "1" } } as const;
  return (
    <box flexDirection="row">
      <text
        onMouseDown={() => {
          if (canGoBack) router.history.back();
        }}
      >
        Back
      </text>
      <text onMouseDown={() => router.history.forward()}>Forward</text>
      <text
        onMouseOver={() => void router.preloadRoute(destination)}
        onMouseDown={() => void navigate(destination)}
      >
        Open note
      </text>
      <text
        onMouseDown={() =>
          void navigate({
            to: ".",
            search: (previous) => ({ ...previous, page: String(page + 1) }),
            replace: true,
          })
        }
      >
        Next page
      </text>
      <text>{pending ? "Opening…" : "Ready"}</text>
    </box>
  );
}
```

Preload on intent (a selected row or hover), using the same destination and search as the
later navigation. It renders the Server page with its authentication checks and reads;
keep page rendering free of writes. For freshness and reuse, read the installed routing
docs' "Preload a page before it opens" section. For terminal history and restoration
limits, use the upstream boundary guide rather than browser setup examples.
