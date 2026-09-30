"use client";
import type { NotFoundProps } from "luciole/client";
import { NotFound } from "../../components/NotFound";

// A missing repository or pull request: the page called notFound() on the Server.
export default function Missing({ what }: NotFoundProps) {
  return <NotFound what={what ?? "Page"} />;
}
