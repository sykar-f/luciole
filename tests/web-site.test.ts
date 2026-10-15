import { expect, test } from "bun:test";
import { runInNewContext } from "node:vm";
import { cellOf, clickOn } from "../scripts/web/site";

const rows = ["+ New note    ", "Shopping list "];
const evaluate = async (expression: string): Promise<unknown> =>
  runInNewContext(expression, {
    lucioleScreen: () => rows,
    lucioleCells: () => rows.map((row) => Array.from({ length: row.length }, () => "cell")),
    document: {
      querySelector: () => ({
        getBoundingClientRect: () => ({ x: 10, y: 20, width: 140, height: 40 }),
      }),
    },
  });

test("cellOf returns the first matching cell's centre; clickOn clicks that literal point", async () => {
  const clicks: unknown[] = [];
  expect(await evaluate(cellOf("Shopping"))).toEqual({ x: 15, y: 50 });
  await clickOn(
    { evaluate, clickAt: async (point) => void clicks.push(await evaluate(point)) },
    "Shopping",
  );
  expect(clicks).toEqual([{ x: 15, y: 50 }]);
});

test("an absent label returns rows without reading geometry; clickOn reports label and screen", async () => {
  const missing = 'absent "label"\nnext';
  const expression = cellOf(missing);
  const result: unknown = runInNewContext(expression, { lucioleScreen: () => rows });
  expect(result).toEqual({ rows });
  let clicked = false;
  const error: unknown = await clickOn(
    {
      evaluate: async () => result,
      clickAt: async () => {
        clicked = true;
      },
    },
    missing,
  ).catch((error: unknown) => error);
  expect(error).toBeInstanceOf(Error);
  expect(error instanceof Error && error.message).toBe(
    `The screen has no label ${JSON.stringify(missing)}\n--- screen\n${rows.join("\n")}`,
  );
  expect(clicked).toBe(false);
});
