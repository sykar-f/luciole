import { Screen } from "./frames";
import { color } from "./theme";

// A missing resource is an expected outcome rendered by the page, not a thrown error.
export function NotFound({ what }: { what: string }) {
  return (
    <Screen title={`${what} not found`} help="i inbox · u back">
      <text fg={color.muted}>It may have been renamed, or you followed an outdated link.</text>
    </Screen>
  );
}
