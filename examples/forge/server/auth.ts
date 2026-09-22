import type { AuthConfig } from "airtty/server";
import { forge } from "./instance";

// Opaque bearer → session in SQLite. Pages and Server Functions are protected by
// default; `/login` and `actions/session.ts` opt out with `export const auth = "public"`.
export default {
  unauthorizedPath: "/login",
  authenticate(request) {
    const token = /^Bearer (.+)$/.exec(request.headers.get("authorization") ?? "")?.[1];
    const actor = forge.authenticate(token);
    return actor
      ? { userId: actor.id, name: actor.name, role: actor.role, sessionId: actor.sessionId }
      : null;
  },
} satisfies AuthConfig;
