# This project was generated with studio

A luciole application: a terminal UI rendered by its Server (React Server Components)
and shown by its Client (OpenTUI). Run it without studio:

```sh
luciole dev --app .
```

## Layout

| Path               | What goes there                                                     |
| ------------------ | ------------------------------------------------------------------- |
| `app/**/page.tsx`  | Pages, rendered on the Server; one folder per route (`app/todos/…`) |
| `app/layout.tsx`   | The frame every page shares (`"use client"`)                        |
| `components/*.tsx` | Client Components: state, hooks, keys (`"use client"` on line 1)    |
| `actions/*.ts`     | Server Functions (`"use server"`), arguments validated with zod     |
| `server/*.ts`      | Data and state of the Server; `data/` is where it may write         |
| `package.json`     | Written by studio only: the app's capabilities                      |

## Rules studio checks

- Packages: `luciole/client`, `luciole/server`, `react`, `@opentui/core`, `@opentui/react`,
  `@tanstack/react-router`, `zod`, `bun:sqlite`; Node's `crypto`, `path`, `url`, `util`,
  `events`, `buffer`. Anything else needs a capability the user grants.
- A page is a Server Component: no `useState`, no `useEffect`; move them to a component
  with `"use client"`.
- OpenTUI elements: `box`, `text`, `select`; colors are `fg` and `bg` (there is no `color`
  prop).
- Fields are `Input` and `Textarea` from `luciole/client`, each with a `name`
  (`name="signup/email"`): studio reloads the app after every change, and only named fields
  get their text back (studio warns about the others). A form is sent with
  `useRestoredFields("signup").submit(…)`; the focused field is kept by
  `useRestoredFocus([…])`, a scroll position by `<ScrollBox name>`. Keys: `useBindings` from `luciole/client`; a
  single letter is only bound while no text field has the focus.
- The preview runs sandboxed: the Server reads its build and writes `data/`, nothing
  else, and reaches no network unless the user allows a host.
