import { notFound } from "airtty/server";
import { FilesReview } from "../../../../../../../components/FilesReview";
import { Screen } from "../../../../../../../components/frames";
import { pullSubtitle, pullTitle } from "../../../../../../../components/PullHeader";
import { actor, forge, slow } from "../../../../../../../server/instance";

// The root model (file list) is sent first; every diff is a Promise prop that Flight
// streams when it resolves. Larger files take longer, like a real repository read.
export default async function FilesPage({ params }: { params: { repo: string; number: string } }) {
  const me = actor();
  const pull = forge.pull(params.repo, Number(params.number));
  if (!pull) notFound(`Pull request ${params.repo}#${params.number}`);
  const comments = forge.comments(pull.id);
  const files = forge.files(pull.id, pull.revision).map((file) => ({
    ...file,
    comments: comments.filter((c) => c.path === file.path),
    diff: slow(1 + (file.additions + file.deletions) / 150).then(() =>
      forge.fileDiff(pull.id, pull.revision, file.path),
    ),
  }));
  return (
    <Screen
      title={pullTitle(pull)}
      subtitle={pullSubtitle(pull)}
      help="[ ] file · j/k line · c comment · v viewed · s split · Space page · Tab checks"
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
