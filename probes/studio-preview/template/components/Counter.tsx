"use client";
import { useState } from "react";
import { useBindings } from "airtty/client";

export function Counter({
  initial,
  increment,
}: {
  initial: number;
  increment: (step: number) => Promise<number>;
}) {
  const [value, setValue] = useState(initial);
  useBindings(
    () => ({
      bindings: [{ key: "+", cmd: () => void increment(1).then(setValue), desc: "increment" }],
    }),
    [increment],
  );
  return <text id="studio-counter">Count: {value} (press + to increment)</text>;
}
