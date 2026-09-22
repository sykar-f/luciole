"use server";
import type { LoginResult } from "../components/model";
import { forge } from "../server/instance";

// Public by design: the only Server Function callable without a session.
export const auth = "public" as const;

export async function login(user: string, pin: string): Promise<LoginResult> {
  return forge.login(user, pin);
}
