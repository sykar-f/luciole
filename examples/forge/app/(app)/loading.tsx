"use client";
import { Screen, SkeletonRows } from "../../components/frames";
import { Help } from "../../components/Help";
import { Pulse } from "../../components/Pulse";

export default function InboxLoading() {
  return (
    <Screen title="Inbox" subtitle="Loading…" help={<Help groups={["airtty"]} />}>
      <Pulse>
        <SkeletonRows count={8} width={70} />
      </Pulse>
    </Screen>
  );
}
