import { expect, test } from "bun:test";
import { messageOf } from "../packages/core/src/guards";
import { rejectionOf, until } from "./helpers";

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
