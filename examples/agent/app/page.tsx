import { AgentScreen } from "../components/AgentScreen";
import { agent } from "../server/agent";

// The first frame shows the conversation as the Server knows it; the live feed takes
// over from there. Rendering the page also boots pi, so it is ready for the first prompt.
export default function AgentPage() {
  void agent.start().catch(() => {});
  return <AgentScreen initial={agent.snapshot()} />;
}
