import { Counter } from "../components/Counter";
import { increment } from "../actions/counter";
import { greeting } from "../server/greeting";
import { count } from "../server/store";

export default function Page() {
  return (
    <box flexDirection="column" gap={1}>
      <text id="studio-greeting">{greeting}</text>
      <Counter initial={count()} increment={increment} />
    </box>
  );
}
