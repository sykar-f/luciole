import { FilesReview } from "../../../../../../../components/FilesReview";
import { Screen } from "../../../../../../../components/frames";
import { Help } from "../../../../../../../components/Help";
import { pullSubtitle, pullTitle } from "../../../../../../../components/PullHeader";
import { actor, forge, pullAt, slow } from "../../../../../../../server/instance";

// Each block of this many changed lines adds one simulated read delay to a file's diff.
const CHANGED_LINES_PER_DELAY = 150;

// The root model (file list) is sent first; every diff is a Promise prop that Flight
// streams when it resolves. Larger files take longer, like a real repository read.
export default async function FilesPage({ params }: { params: { repo: string; number: string } }) {
  const me = actor();
  const pull = pullAt(params);
  const comments = forge.comments(pull.id);
  const files = forge.files(pull.id, pull.revision).map((file) => ({
    ...file,
    comments: comments.filter((c) => c.path === file.path),
    diff: slow(1 + (file.additions + file.deletions) / CHANGED_LINES_PER_DELAY).then(() =>
      forge.fileDiff(pull.id, pull.revision, file.path),
    ),
  }));
  return (
    <Screen
      title={pullTitle(pull)}
      subtitle={pullSubtitle(pull)}
      help={<Help groups={["files", "draft"]} />}
    >
      <FilesReview
        pull={pull}
        files={files}
        composerVersions={forge.composerVersions(me, pull.id)}
        canComment={me.role !== "reader"}
      />
    </Screen>
  );
}
