import { notFound } from "airtty/server";
import { Conversation } from "../../../../../../components/Conversation";
import { Screen } from "../../../../../../components/frames";
import { pullSubtitle, pullTitle } from "../../../../../../components/PullHeader";
import { conversationSlot } from "../../../../../../server/forge";
import { actor, forge, slow } from "../../../../../../server/instance";

export default async function ConversationPage({
  params,
}: {
  params: { repo: string; number: string };
}) {
  await slow();
  const me = actor();
  const pull = forge.pull(params.repo, Number(params.number));
  if (!pull) notFound(`Pull request ${params.repo}#${params.number}`);
  return (
    <Screen
      title={pullTitle(pull)}
      subtitle={pullSubtitle(pull)}
      help="e edit · c comment · a approve · x changes · m merge · j/k scroll · Tab files · Esc stop editing"
    >
      <Conversation
        pull={pull}
        me={{ id: me.id, name: me.name, role: me.role }}
        description={forge.descriptionNote(pull.id)}
        composer={forge.composerNote(me, conversationSlot(pull.id))}
        comments={forge.comments(pull.id)}
        reviews={forge.reviews(pull.id)}
        readiness={forge.readiness(pull.id)}
        now={forge.now()}
      />
    </Screen>
  );
}
