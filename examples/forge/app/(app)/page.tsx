import { Suspense } from "react";
import { Activity } from "../../components/Activity";
import { Line, Screen, SkeletonRows } from "../../components/frames";
import { PullList } from "../../components/PullList";
import { color } from "../../components/theme";
import { actor, forge } from "../../server/instance";

export default function InboxPage() {
  const me = actor();
  const inbox = forge.inbox(me);
  return (
    <Screen
      title={`Inbox · ${inbox.reviewRequested.length} review(s) requested`}
      subtitle={`Signed in as ${me.name} (${me.role})`}
      help="↑↓ select · Enter open · / filter · 1-9 repository · ? keys"
    >
      <box flexDirection="column" flexGrow={1} gap={1}>
        <PullList
          sections={[
            { title: "Review requested", pulls: inbox.reviewRequested },
            { title: "Your pull requests", pulls: inbox.mine },
            { title: "Following", pulls: inbox.following },
          ]}
          emptyText="Nothing to review"
        />
        <box flexDirection="column" height={8} flexShrink={0}>
          <Line fg={color.muted}>RECENT ACTIVITY</Line>
          <Suspense fallback={<SkeletonRows count={6} />}>
            <Activity />
          </Suspense>
        </box>
      </box>
    </Screen>
  );
}
