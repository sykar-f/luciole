"use server";
import type { Identity, Repo } from "../components/model";
import { actor, forge } from "../server/instance";

// Reads for the persistent chrome: layouts are Client Components and cannot read the
// session themselves. Calling them renders no page.
export async function whoami(): Promise<Identity> {
  const { id, name, role } = actor();
  return { id, name, role };
}
export async function listRepos(): Promise<Repo[]> {
  actor();
  return forge.repos();
}
export async function logout(): Promise<void> {
  forge.logout(actor());
}
