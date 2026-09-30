import { command } from "../../actions/bus";
import { RouterPanel } from "../../components/Router";

export default function RouterPage() {
  return <RouterPanel command={command} />;
}
