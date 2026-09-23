import { Conversation } from "../../../../../../components/Conversation";
import { Screen } from "../../../../../../components/frames";
import { Help } from "../../../../../../components/Help";
import { pullSubtitle, pullTitle } from "../../../../../../components/PullHeader";
import { conversationSlot } from "../../../../../../server/forge";
import { actor, forge, pullAt, slow } from "../../../../../../server/instance";

export default async function ConversationPage({
  params,
}: {
  params: { repo: string; number: string };
}) {
  await slow();
  const me = actor();
  const pull = pullAt(params);
  return (
    <Screen
      title={pullTitle(pull)}
      subtitle={pullSubtitle(pull)}
      help={<Help groups={["conversation", "draft"]} />}
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
