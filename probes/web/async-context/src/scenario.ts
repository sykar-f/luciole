/**
 * What the Server needs of async context, as 50 interleaved requests: each runs in its own
 * store and checks, after every kind of wait a Server Function or a live stream uses,
 * that it still sees its own request. Returns the mismatches (none is the pass).
 */
import { AsyncLocalStorage } from "node:async_hooks";

type Request = { id: number };
const context = new AsyncLocalStorage<Request>();
const nested = new AsyncLocalStorage<string>();
const REQUESTS = 50;
const MAX_DELAY_MS = 5;
const LIVE_VALUES = 3;

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const randomDelay = () => delay(Math.random() * MAX_DELAY_MS);

async function* live(id: number) {
  for (let i = 0; i < LIVE_VALUES; i++) {
    await randomDelay();
    yield context.getStore()?.id === id ? "ok" : `live ${i} saw ${context.getStore()?.id}`;
  }
}

async function serverFunction(id: number, seen: string[]) {
  const expect = (where: string) => {
    const store = context.getStore()?.id;
    if (store !== id) seen.push(`${where}: request ${id} saw ${store}`);
  };
  expect("start");
  await randomDelay();
  expect("after await delay");
  await Promise.resolve();
  expect("after await resolved");
  await Promise.all([randomDelay(), randomDelay()]);
  expect("after Promise.all");
  await new Promise<void>((resolve) => queueMicrotask(() => (expect("queueMicrotask"), resolve())));
  await randomDelay().then(() => expect("then callback"));
  await new Promise<void>((resolve) => setTimeout(() => (expect("setTimeout"), resolve()), 1));
  for await (const result of live(id)) {
    if (result !== "ok") seen.push(`request ${id}: ${result}`);
    expect("for await body");
  }
  expect("after for await");
  await nested.run(`inner ${id}`, async () => {
    await randomDelay();
    if (nested.getStore() !== `inner ${id}`) seen.push(`nested store lost in ${id}`);
    expect("inside nested run");
  });
  if (nested.getStore() !== undefined) seen.push(`nested store leaked in ${id}`);
}

export async function scenario() {
  const seen: string[] = [];
  await Promise.all(
    Array.from({ length: REQUESTS }, (_, id) =>
      delay(Math.random() * MAX_DELAY_MS).then(() =>
        context.run({ id }, () => serverFunction(id, seen)),
      ),
    ),
  );
  return { requests: REQUESTS, mismatches: seen };
}
