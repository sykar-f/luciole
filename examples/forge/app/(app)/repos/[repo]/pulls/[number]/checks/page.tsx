import { notFound } from "airtty/server";
import { ChecksPanel } from "../../../../../../../components/ChecksPanel";
import { Screen } from "../../../../../../../components/frames";
import { Help } from "../../../../../../../components/Help";
import { pullSubtitle, pullTitle } from "../../../../../../../components/PullHeader";
import { actor, forge } from "../../../../../../../server/instance";

export default function ChecksPage({ params }: { params: { repo: string; number: string } }) {
  const me = actor();
  const pull = forge.pull(params.repo, Number(params.number));
  if (!pull) notFound(`Pull request ${params.repo}#${params.number}`);
  // Logs are not rendered here: the Checks tab subscribes to them while it is open.
  const checks = forge.checks(pull.id, pull.revision);
  return (
    <Screen
      title={pullTitle(pull)}
      subtitle={pullSubtitle(pull)}
      help={<Help groups={["checks"]} />}
    >
      <ChecksPanel
        pull={pull}
        checks={checks}
        canRun={me.role !== "reader" && pull.state === "open"}
      />
    </Screen>
  );
}
