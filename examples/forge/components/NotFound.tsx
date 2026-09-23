import { Screen } from "./frames";
import { Help } from "./Help";
import { color } from "./theme";

// Shown by app/(app)/not-found.tsx when a page calls notFound() for a missing resource.
export function NotFound({ what }: { what: string }) {
  return (
    <Screen title={`${what} not found`} help={<Help groups={["app"]} />}>
      <text fg={color.muted}>It may have been renamed, or you followed an outdated link.</text>
    </Screen>
  );
}
