import { expect, test } from "bun:test";
import { Browser } from "../scripts/web/cdp";

class SilentTransport extends EventTarget {
  readonly url = "ws://fake.test/cdp";
  send() {}
  close() {}
}

for (const method of ["Runtime.evaluate", "Page.navigate"]) {
  test(`CDP timeout diagnoses ${method} without an unbounded expression`, async () => {
    // Bypass Chrome startup: this transport deliberately never replies.
    const instance: unknown = Reflect.construct(Browser, [
      async () => {},
      new SilentTransport(),
      1,
    ]);
    if (!(instance instanceof Browser)) throw new Error("Expected a Browser instance");
    await using browser = instance;
    const prefix = "diagnostic expression ".repeat(10).slice(0, 200);
    const expression = prefix + "OMITTED TAIL";
    const error: unknown = await browser
      .send(method, { expression })
      .catch((error: unknown) => error);
    expect(error).toBeInstanceOf(Error);
    if (!(error instanceof Error)) throw new Error("Expected a command timeout");
    expect(error.message).toBe(
      `${method}: CDP target ws://fake.test/cdp exceeded 1 ms` +
        (method === "Runtime.evaluate" ? `; expression: ${prefix}` : ""),
    );
  });
}
