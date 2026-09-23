import { ChecksPanel } from "../../../../../../../components/ChecksPanel";
import { Screen } from "../../../../../../../components/frames";
import { pullSubtitle, pullTitle } from "../../../../../../../components/PullHeader";
import { actor, forge, pullAt } from "../../../../../../../server/instance";

export default function ChecksPage({ params }: { params: { repo: string; number: string } }) {
  const me = actor();
  const pull = pullAt(params);
  // Logs are not rendered here: the Checks tab subscribes to them while it is open.
  const checks = forge.checks(pull.id, pull.revision);
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
