// The GPU renderer for a terminal of the page, as the web runtime loads it for its own
// (packages/luciole/src/web/platform/run.tsx, `drawOnGpu`): the capture that stands in for
// a live demo must draw every cell as the runtime will, blocks and frames to the pixel,
// or the one replacing the other would show. The same fallback: without WebGL2, or once
// the browser takes the context back (it keeps about sixteen), the DOM renderer at once.
import { WebglAddon } from "@xterm/addon-webgl";
import type { Terminal } from "@xterm/xterm";

/** Loads the GPU renderer on an opened terminal, before its font is sized. */
export function drawOnGpu(terminal: Terminal) {
  let webgl: WebglAddon | undefined;
  const fallBack = () => {
    webgl?.dispose();
    webgl = undefined;
  };
  try {
    webgl = new WebglAddon();
    webgl.onContextLoss(fallBack);
    terminal.loadAddon(webgl);
    terminal.element
      ?.querySelector(".xterm-screen canvas")
      ?.addEventListener("webglcontextlost", fallBack);
  } catch {
    fallBack();
  }
}
