import { notFound } from "airtty/server";
import { Screen } from "../../../../../../components/frames";
import { NewPullForm } from "../../../../../../components/NewPullForm";
import { newPullSlot } from "../../../../../../server/forge";
import { actor, forge } from "../../../../../../server/instance";

// Static segment: `/repos/x/pulls/new` never reaches the `[number]` page.
export default function NewPullPage({ params }: { params: { repo: string } }) {
  const me = actor();
  const repo = forge.repo(params.repo);
  if (!repo) notFound(`Repository ${params.repo}`);
  const branches = forge.availableBranches(repo.slug);
  return (
    <Screen
      title={`Open a pull request in ${repo.slug}`}
      subtitle="Compare a branch with main"
      help="Tab field · Ctrl+S open · u back"
    >
      <NewPullForm
        repo={repo.slug}
        branches={branches}
        composer={forge.composerNote(me, newPullSlot(repo.slug))}
      />
    </Screen>
  );
}
