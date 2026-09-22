import { ChecksPanel } from "../../../../../../../components/ChecksPanel";
import { Screen } from "../../../../../../../components/frames";
import { NotFound } from "../../../../../../../components/NotFound";
import { pullSubtitle, pullTitle } from "../../../../../../../components/PullHeader";
import { actor, forge } from "../../../../../../../server/instance";

export default function ChecksPage({ params }: { params: { repo: string; number: string } }) {
  const me = actor();
  const pull = forge.pull(params.repo, Number(params.number));
  if (!pull) return <NotFound what={`Pull request ${params.repo}#${params.number}`} />;
  // Each log is an async generator: Flight streams its lines as the clock reaches them.
  const checks = forge.checks(pull.id, pull.revision).map((check) => ({
    ...check,
    log: forge.checkLog(check.id),
  }));
  return (
    <Screen
      title={pullTitle(pull)}
      subtitle={pullSubtitle(pull)}
      help="↑↓ select check · r rerun · Ctrl+O resolve · Tab conversation"
    >
      <ChecksPanel
        pull={pull}
        checks={checks}
        canRun={me.role !== "reader" && pull.state === "open"}
      />
    </Screen>
  );
}
