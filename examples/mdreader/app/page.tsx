import { notFound } from "airtty/server";
import { Column, DocFrame, Line } from "../components/frames";
import { Help } from "../components/Help";
import { Reader } from "../components/Reader";
import { color } from "../components/theme";
import { library, readDoc } from "../server/library";

// The home document: the file named by MD_PATH, or README.md / index.md / the first
// document of the directory.
export default async function HomePage() {
  const { home, problem, root } = await library();
  if (!home)
    return (
      <DocFrame
        title={problem ? "Nothing to read" : "No Markdown document"}
        subtitle={root}
        help={<Help groups={["global"]} />}
      >
        <Column>
          <Line fg={color.warn}>{problem ?? `No .md file under ${root}`}</Line>
          <Line fg={color.muted}>Start again with MD_PATH=/path/to/docs or a single file.md</Line>
        </Column>
      </DocFrame>
    );
  const doc = await readDoc(home);
  if (!doc) notFound(home);
  return <Reader key={doc.path} doc={doc} />;
}
