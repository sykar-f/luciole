import { command } from "../../actions/bus";
import { CachePanel } from "../../components/Cache";

export default function CachePage() {
  return <CachePanel command={command} />;
}
