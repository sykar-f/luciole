import { command } from "../../actions/bus";
import { ConditionsPanel } from "../../components/Conditions";

export default function ConditionsPage() {
  return <ConditionsPanel command={command} />;
}
