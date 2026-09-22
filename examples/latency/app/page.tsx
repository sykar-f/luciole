import { Playground } from "../components/Playground";
import { ping } from "../actions/ping";
export default function Page() {
  return <Playground ping={ping} />;
}
