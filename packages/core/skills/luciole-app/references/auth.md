# Authentication

The full rules: `node_modules/@luciole-sh/core/docs/concepts/authentication.md`.

- Every page and every `"use server"` module requires a sign-in session unless it exports
  `auth = "public"`. Without `server/auth.ts`, the app has one user, `LUCIOLE_USER`
  (`local`), and `getSession().userId` is that user.
- `server/auth.ts` exports by default an object that `satisfies AuthConfig`:
  `authenticate(request)` returns `{ userId, …fields }` or `null`, and the optional
  `unauthorizedPath` names a **public** route, or the Server refuses to start.
- A public page: `export const auth = "public" as const;` beside its default export. A public
  Server Function lives in a module of its own that exports the same constant: Forge's
  `actions/session.ts` holds `login` alone.
- After a sign-in, the Client calls `useApplication().setToken(token)`, then navigates;
  `setToken(undefined)` signs out. `setToken` reloads the routes but never navigates.
- `getSession()` throws for an anonymous request; `getOptionalSession()` returns `null`. Use
  the second on a public page.
- Check permissions in the Server Function or the repository that touches the data. A
  protected route or a Server Function reference grants nothing by itself.
- A layout shows the user's name from a Server Function or a page, never from
  `getSession()`.

Forge (`luciole example forge`) is the example with sign-in: `server/auth.ts`,
`app/(public)/login/page.tsx`, `actions/session.ts`, `components/LoginForm.tsx`.
