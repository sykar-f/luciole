/** @jsxImportSource @opentui/react */
// An OpenTUI program (what a luciole Client is) run inside <VtView>: it probes the host
// terminal at startup (DA1, OSC 10/11, kitty keyboard…), so it shows whether the embedding
// emulator answers enough for a luciole app to start in `process` mode.
import { createCliRenderer } from "@opentui/core";
import { createRoot, useKeyboard, useRenderer } from "@opentui/react";
import { useState } from "react";

const SHOWN_KEYS_WIDTH = 40;
function Child() {
  const [keys, setKeys] = useState("");
  const renderer = useRenderer();
  useKeyboard((key) => {
    // destroy() leaves the alternate screen and restores modes; exit() alone would not.
    if (key.name === "q") {
      renderer.destroy();
      process.exit(0);
    }
    setKeys((k) => (k + " " + key.name).slice(-SHOWN_KEYS_WIDTH));
  });
  return (
    <box border title="opentui child" flexDirection="column">
      <text>opentui child ready</text>
      <text>keys:{keys}</text>
    </box>
  );
}
const renderer = await createCliRenderer({ exitOnCtrlC: true });
createRoot(renderer).render(<Child />);
