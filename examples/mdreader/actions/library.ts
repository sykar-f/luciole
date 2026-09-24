"use server";
import { library, libraryChanges } from "../server/library";

/** Documents of the library, for the sidebar (read again after every change). */
export async function listDocs() {
  return library();
}

/** Live: one value each time a Markdown file of the library changes on disk. */
export async function watchLibrary() {
  return libraryChanges();
}
