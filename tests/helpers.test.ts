import { expect, spyOn, test } from "bun:test";
import * as React from "react";
import { messageOf } from "../packages/core/src/guards";
import { eventually, rejectionOf, until } from "./helpers";

test("until: a timeout says so, with the state when there is one", async () => {
  const plain = await rejectionOf(until(() => false, 20));
  expect(messageOf(plain)).toBe("Condition timed out");
  const described = await rejectionOf(
    until(
      () => false,
      20,
      () => "the screen showed X",
    ),
  );
  expect(messageOf(described)).toContain("Condition timed out");
  expect(messageOf(described)).toContain("the screen showed X");
});

test("until: a state that throws does not replace the timeout", async () => {
  const failure = await rejectionOf(
    until(
      () => false,
      20,
      () => {
        throw new Error("state broke");
      },
    ),
  );
  expect(messageOf(failure)).toContain("Condition timed out");
  expect(messageOf(failure)).toContain("state broke");
});

for (const environment of [undefined, false]) {
  test(`plain condition waits emit no React warning with act environment ${environment}`, async () => {
    const previous = Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT");
    const hadEnvironment = Object.hasOwn(globalThis, "IS_REACT_ACT_ENVIRONMENT");
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", environment);
    const act = spyOn(React, "act");
    const errors = spyOn(console, "error");
    const warnings = spyOn(console, "warn");
    try {
      let polls = 0;
      await until(() => ++polls === 3);
      let asks = 0;
      await eventually(async () => ++asks === 3);
      expect(polls).toBe(3);
      expect(asks).toBe(3);
      expect(Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT")).toBe(environment);
      expect(act).not.toHaveBeenCalled();
      expect(errors.mock.calls).toEqual([]);
      expect(warnings.mock.calls).toEqual([]);
    } finally {
      act.mockRestore();
      errors.mockRestore();
      warnings.mockRestore();
      if (hadEnvironment) Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", previous);
      else Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
    }
  });
}
