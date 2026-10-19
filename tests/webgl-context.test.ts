import { expect, test } from "bun:test";
import type { Terminal } from "@xterm/xterm";
import { WebglAddon } from "../packages/core/src/web/xterm-webgl/addon/WebglAddon";

for (const preserve of [undefined, false, true]) {
  test(`WebGL addon requests buffer preservation ${preserve ?? "by default"}`, () => {
    const requests: { type: string; attributes: WebGLContextAttributes }[] = [];
    const stop = new Error("Stop after the WebGL context request");
    const canvas = {
      classList: { add() {} },
      getContext(type: string, attributes: WebGLContextAttributes) {
        requests.push({ type, attributes });
        // The test needs the real context request, but no GPU or render layers.
        throw stop;
      },
    };
    const terminal = {
      element: {},
      _core: {
        _coreBrowserService: {
          mainDocument: {
            createElement(tag: string) {
              expect(tag).toBe("canvas");
              return canvas;
            },
          },
        },
        _logService: { logLevel: 4 },
      },
    } as unknown as Terminal;
    const addon = preserve === undefined ? new WebglAddon() : new WebglAddon(preserve);

    expect(() => addon.activate(terminal)).toThrow(stop);
    expect(requests).toEqual([
      {
        type: "webgl2",
        attributes: { antialias: false, depth: false, preserveDrawingBuffer: preserve ?? true },
      },
    ]);
  });
}
