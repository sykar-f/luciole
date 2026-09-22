"use client";
import { useState } from "react";
export function Playground({ ping }: { ping: () => Promise<string> }) {
  const [value, setValue] = useState("");
  const [hover, setHover] = useState(false);
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState(
    "Enter sends a request. Keep typing, scrolling and hovering while waiting.",
  );
  async function send() {
    if (pending) return;
    setPending(true);
    const start = performance.now();
    try {
      const reply = await ping();
      setResult(`${reply} in ${Math.round(performance.now() - start)} ms`);
    } catch (error) {
      setResult(String(error));
    } finally {
      setPending(false);
    }
  }
  return (
    <box flexDirection="column" gap={1} flexGrow={1}>
      <text>LATENCY PLAYGROUND · local input / scroll / hover</text>
      <input
        id="latency-input"
        focused
        value={value}
        onInput={setValue}
        onSubmit={() => void send()}
        placeholder="Type here; Enter calls the Server"
      />
      <text>{pending ? "Waiting for Server…" : result}</text>
      <box
        id="latency-hover"
        height={3}
        border
        backgroundColor={hover ? "#285f50" : "#233044"}
        onMouseOver={() => setHover(true)}
        onMouseOut={() => setHover(false)}
      >
        <text>{hover ? "Hover active (local)" : "Move the mouse here"}</text>
      </box>
      <scrollbox id="latency-scroll" height={8} scrollY>
        {Array.from({ length: 100 }, (_, i) => (
          <text key={i}>Local row {i + 1} — scroll with the mouse wheel</text>
        ))}
      </scrollbox>
      <text>Input: {value}</text>
    </box>
  );
}
