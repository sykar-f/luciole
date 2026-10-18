/** Node's cancellable immediate queue for a page, one MessageChannel task per callback. */
if (typeof globalThis.setImmediate !== "function") {
  let nextHandle = 0;
  let channel: MessageChannel | undefined;
  const callbacks = new Map<number, () => void>();
  Object.assign(globalThis, {
    setImmediate(callback: (...args: unknown[]) => void, ...args: unknown[]) {
      if (typeof callback !== "function") throw new TypeError("setImmediate requires a callback");
      channel ??= new MessageChannel();
      channel.port1.onmessage ??= (event: MessageEvent<number>) => {
        const run = callbacks.get(event.data);
        callbacks.delete(event.data);
        run?.();
      };
      const handle = ++nextHandle;
      callbacks.set(handle, () => callback(...args));
      channel.port2.postMessage(handle);
      return handle;
    },
    clearImmediate(handle: number) {
      callbacks.delete(handle);
    },
  });
}
