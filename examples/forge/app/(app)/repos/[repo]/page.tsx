import { notFound } from "airtty/server";
import { Screen } from "../../../../components/frames";
import { Help } from "../../../../components/Help";
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
  if (!repo) notFound(`Repository ${params.repo}`);
  const state = stateOf(searchParams.state);
  return (
    <Screen
      title={`${repo.slug} · ${repo.openPulls} open pull request(s)`}
      subtitle={repo.description}
      help={<Help groups={["list", "repo"]} />}
    >
      <RepoPulls repo={repo.slug} state={state} pulls={forge.pulls(repo.slug, state)} />
    </Screen>
  );
}
