import { expect, spyOn, test } from "bun:test";
import type { ServerFunction } from "../packages/core/src/server";

// Each renderer runs in its own react-server process, through live-cancel.test.ts.
if (process.env.FLIGHT_ENTRY === "web") {
  Bun.plugin({
    name: "web-flight",
    setup(build) {
      build.onLoad({ filter: /\/src\/flight\/server\.ts$/ }, () => ({
        loader: "ts",
        contents: `export * from "${new URL("../packages/core/src/web/platform/flight/server.ts", import.meta.url).pathname}";`,
      }));
    },
  });
}
const { abortable, createHandler, getSignal } = await import("../packages/core/src/server");

function deferred<T>() {
  let resolve = (_value: T) => {};
  let reject = (_error: unknown) => {};
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

async function within<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Cancellation exceeded 500 ms")), 500);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function responseFor(fn: ServerFunction, signal: AbortSignal) {
  const handle = createHandler(
    {
      buildId: "cancel-test",
      manifest: {},
      routes: new Map(),
      actions: new Map([["watch", { fn, auth: "public" }]]),
    },
    { auth: { authenticate: () => null } },
  );
  return handle(
    new Request("http://localhost/action", {
      method: "POST",
      body: "[]",
      signal,
      headers: { "x-luciole-build": "cancel-test", "x-luciole-action": "watch" },
    }),
  );
}

for (const mode of ["request", "reader"] as const) {
  test(`${mode} cancellation releases a generator blocked on a silent source`, async () => {
    const started = deferred<void>();
    const closed = deferred<number>();
    let captured: AbortSignal | undefined;
    async function* watch() {
      const signal = getSignal();
      captured = signal;
      try {
        yield "initial";
        started.resolve();
        await abortable(new Promise<never>(() => {}), signal);
      } finally {
        closed.resolve(performance.now());
      }
    }
    const cancel = new AbortController();
    const response = await responseFor(watch, cancel.signal);
    expect(response.status).toBe(200);
    const body = response.body;
    if (!body) throw new Error("Missing response body");
    const reader = body.getReader();
    const drained = (async () => {
      while (!(await reader.read()).done) {
        /* drain Flight metadata and values */
      }
    })();
    await started.promise;
    const at = performance.now();
    if (mode === "request") cancel.abort(new Error("gone"));
    else await within(reader.cancel(new Error("gone")));
    const ended = await within(closed.promise);
    await within(drained);
    expect(captured?.aborted).toBe(true);
    expect(ended - at).toBeLessThan(500);
    console.log(`${process.env.FLIGHT_ENTRY} ${mode} finally: ${(ended - at).toFixed(2)} ms`);
  });
}

test("response ends even when an async generator ignores its signal", async () => {
  const pending = deferred<void>();
  const started = deferred<void>();
  const closed = deferred<void>();
  let cleaned = false;
  async function* ignoresSignal() {
    try {
      yield "initial";
      started.resolve();
      await pending.promise;
      yield "too late";
    } finally {
      cleaned = true;
      closed.resolve();
    }
  }
  const cancel = new AbortController();
  const response = await responseFor(ignoresSignal, cancel.signal);
  const drained = response.text();
  await started.promise;
  cancel.abort();
  const text = await within(drained);
  expect(cleaned).toBe(false);
  expect(text).toContain("initial");
  expect(text).not.toContain("too late");
  pending.resolve();
  await within(closed.promise);
});

test("request cancellation ends the response while next and return remain blocked", async () => {
  const pending = deferred<IteratorResult<string>>();
  const started = deferred<void>();
  const returned = deferred<void>();
  const failedReturn = deferred<IteratorResult<string>>();
  const logs = spyOn(console, "error").mockImplementation(() => {});
  const cancel = new AbortController();
  let reads = 0;
  const source = {
    [Symbol.asyncIterator]() {
      return {
        next() {
          reads++;
          started.resolve();
          return pending.promise;
        },
        return() {
          returned.resolve();
          return failedReturn.promise;
        },
      };
    },
  };
  try {
    const response = await responseFor(() => source, cancel.signal);
    const drained = response.text();
    await started.promise;
    cancel.abort();
    await within(drained);
    await within(returned.promise);
    expect(reads).toBe(1);
    expect(logs).not.toHaveBeenCalled();
    // A late cleanup failure is observed in the background and logged once.
    failedReturn.reject(new TypeError("cleanup failed"));
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(logs).toHaveBeenCalledTimes(1);
    expect(logs.mock.calls[0]?.[0]).toBe("Live cleanup failed");
    pending.reject(new Error("late next failure"));
    await Promise.resolve();
  } finally {
    logs.mockRestore();
  }
});

test("natural completion and source failures still travel through Flight", async () => {
  const complete = await responseFor(async function* () {
    yield "last";
    return "final value";
  }, new AbortController().signal);
  const text = await complete.text();
  expect(text).toContain("last");
  expect(text).toContain("final value");
  expect(text).toMatch(/\n[0-9a-f]+:x\n/);
  const iterable = {
    async *[Symbol.asyncIterator]() {
      yield "replayable";
    },
  };
  const replayable = await responseFor(() => iterable, new AbortController().signal);
  expect(await replayable.text()).toMatch(/\n[0-9a-f]+:X\n/);
  const failed = await responseFor(async function* () {
    yield "before failure";
    throw new Error("source failed");
  }, new AbortController().signal);
  expect(await failed.text()).toContain('"digest":"Server render failed"');
});

test("getSignal requires request context", () => {
  expect(() => getSignal()).toThrow("No request signal");
});

test("abortable preserves settlement, abort reason, and removes listeners", async () => {
  const cancel = new AbortController();
  const remove = spyOn(cancel.signal, "removeEventListener");
  expect(await abortable(Promise.resolve(42), cancel.signal)).toBe(42);
  const failure = new Error("source failure");
  expect(
    await abortable(Promise.reject(failure), cancel.signal).catch((error: unknown) => error),
  ).toBe(failure);
  const pending = deferred<number>();
  const raced = abortable(pending.promise, cancel.signal);
  const reason = new Error("gone");
  cancel.abort(reason);
  expect(await raced.catch((error: unknown) => error)).toBe(reason);
  expect(remove).toHaveBeenCalledTimes(3);
  pending.reject(failure);
  expect(
    await abortable(Promise.reject(failure), cancel.signal).catch((error: unknown) => error),
  ).toBe(reason);
  remove.mockRestore();
});
