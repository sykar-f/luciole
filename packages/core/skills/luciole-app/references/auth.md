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

## Sign-in, end to end

`server/auth.ts` turns a request into a sign-in session. Here `server/accounts.ts`, which
imports `server-only`, checks a PIN in `signIn` and keeps the tokens it issued for `userOf`:

```ts
import type { AuthConfig } from "@luciole-sh/core/server";
import { userOf } from "./accounts";

export default {
  unauthorizedPath: "/login",
  authenticate(request) {
    const token = /^Bearer (.+)$/.exec(request.headers.get("authorization") ?? "")?.[1];
    const user = userOf(token);
    return user ? { userId: user } : null;
  },
} satisfies AuthConfig;
```

The sign-in itself is a public Server Function, in a module of its own, that returns a token:

```ts
"use server";
import { z } from "zod";
import { signIn } from "../server/accounts";

export const auth = "public" as const;

export async function login(user: string, pin: string): Promise<string | null> {
  return signIn(z.string().parse(user), z.string().parse(pin));
}
```

`app/login/page.tsx` exports `auth = "public" as const` and renders a Client form, which hands
the token to the Client and then navigates:

```tsx
"use client";
import { useApplication, useNavigate } from "@luciole-sh/core/client";
import { login } from "../actions/session";

export function useSignIn() {
  const app = useApplication();
  const navigate = useNavigate();
  return async (user: string, pin: string) => {
    const token = await login(user, pin);
    if (!token) return false;
    app.setToken(token);
    await navigate({ to: "/" });
    return true;
  };
}
```

The root layout renders on `/login` too: what it reads through protected Server Functions
fails there with `AuthenticationRequired` until the user signs in.

Forge (`luciole example forge`) is the example with sign-in: `server/auth.ts`,
`app/(public)/login/page.tsx`, `actions/session.ts`, `components/LoginForm.tsx`.
