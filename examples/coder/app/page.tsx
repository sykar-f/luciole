import { SessionScreen } from "../components/SessionScreen";
import { session } from "../server/session";

// The first frame shows the session as the Server knows it; the live feed takes over
// from there. Rendering the page also starts the harness, ready for the first prompt.
export default function SessionPage() {
  void session.start();
  return <SessionScreen initial={session.snapshot()} />;
}
