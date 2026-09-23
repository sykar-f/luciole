import { notFound } from "airtty/server";
import { Explorer } from "../components/Explorer";
import { Screen } from "../components/frames";
import { Help } from "../components/Help";
import { Title } from "../components/Title";
import { list } from "../server/fs";

// One page for every directory: `?dir=` is the path below the root. Each directory is a
// history entry, rendered on the Server from the file system it reads.
export default async function DirectoryPage({
  searchParams,
}: {
  searchParams: Record<string, string>;
}) {
  const path = searchParams.dir ?? "";
  const listing = await list(path);
  if (!listing) notFound(path);
  return (
    <Screen
      title={<Title root={listing.root} path={path} />}
      subtitle={`${listing.root}${path ? `/${path}` : ""} · ${listing.entries.length} entries`}
      help={<Help groups={["files", "preview"]} />}
    >
      <Explorer key={path} listing={listing} />
    </Screen>
  );
}
