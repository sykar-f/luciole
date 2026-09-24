import { notFound } from "airtty/server";
import { Reader } from "../../../components/Reader";
import { readDoc } from "../../../server/library";

// `path` comes from the Client: readDoc only opens a Markdown file of the library.
// Keyed by path, the Reader starts fresh for another document and keeps its scroll
// position when the same document is re-rendered after a change on disk.
export default async function DocPage({ params }: { params: { path: string } }) {
  const doc = await readDoc(params.path);
  if (!doc) notFound(params.path);
  return <Reader key={doc.path} doc={doc} />;
}
