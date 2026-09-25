import { command } from "../../actions/bus";
import { ComponentsPanel } from "../../components/Components";

export default function ComponentsPage() {
  return <ComponentsPanel command={command} />;
}
