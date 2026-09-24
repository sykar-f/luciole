import { Chat } from "../components/Chat";
import { describeSetup } from "../server/openrouter";

// The page only describes the configuration (model, price, whether a key exists). The
// conversation itself is Client state; replies stream through `actions/chat.ts`.
export default async function ChatPage() {
  return <Chat setup={await describeSetup()} />;
}
