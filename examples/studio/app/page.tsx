import { StudioScreen } from "../components/StudioScreen";
import { studio } from "../server/studio";

// The first frame shows the studio as the Server knows it; the live feeds take over from
// there. Rendering the page also opens the project and starts the harness.
export default function StudioPage() {
  void studio.open();
  return <StudioScreen initial={studio.session.snapshot()} studio={studio.snapshot()} />;
}
