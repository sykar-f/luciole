# Routing

The full rules: `node_modules/@luciole-sh/core/docs/concepts/routing.md`.

## A layout over a dynamic route

`app/notes/[id]/layout.tsx` wraps `app/notes/[id]/page.tsx` and every page below it, such
as `app/notes/[id]/info/page.tsx`, and stays mounted while the user moves between them. It
receives the params of the route; its `children` is where the page renders.

```tsx
"use client";
import { useNavigate, type LayoutProps } from "@luciole-sh/core/client";

export default function NoteTabs({ children, params }: LayoutProps) {
  const navigate = useNavigate();
  const id = params["id"] ?? "";
  return (
    <box flexDirection="column" flexGrow={1}>
      <box flexDirection="row" flexShrink={0}>
        <text onMouseDown={() => void navigate({ to: "/notes/$id", params: { id } })}>Note</text>
        <text onMouseDown={() => void navigate({ to: "/notes/$id/info", params: { id } })}>
          Info
        </text>
      </box>
      {children}
    </box>
  );
}
```

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
