"use client";
import { Screen, SkeletonRows } from "../../components/frames";
import { Pulse } from "../../components/Pulse";

export default function InboxLoading() {
  return (
    <Screen title="Inbox" subtitle="Loading…" help="Esc cancel">
      <Pulse>
        <SkeletonRows count={8} width={70} />
      </Pulse>
    </Screen>
  );
}
