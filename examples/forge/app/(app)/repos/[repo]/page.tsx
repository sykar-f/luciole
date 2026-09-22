import { Screen } from "../../../../components/frames";
import { NotFound } from "../../../../components/NotFound";
import { stateOf } from "../../../../components/filters";
import { RepoPulls } from "../../../../components/RepoPulls";
import { forge } from "../../../../server/instance";

export default function RepoPage({
  params,
  searchParams,
}: {
  params: { repo: string };
  searchParams: Record<string, string>;
}) {
  const repo = forge.repo(params.repo);
  if (!repo) return <NotFound what={`Repository ${params.repo}`} />;
  const state = stateOf(searchParams.state);
  return (
    <Screen
      title={`${repo.slug} · ${repo.openPulls} open pull request(s)`}
      subtitle={repo.description}
      help="↑↓ select · Enter open · / filter · s state (URL) · n new pull request · u back"
    >
      <RepoPulls repo={repo.slug} state={state} pulls={forge.pulls(repo.slug, state)} />
    </Screen>
  );
}
