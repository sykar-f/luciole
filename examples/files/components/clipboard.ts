import type { CliRenderer } from "@opentui/core";
import { CapabilityDenied, host } from "luciole/client";

/**
 * Copies `text`; `false` when nothing accepted it. The host first: the Client itself
 * (the system tool) on its own or inline, the host process when sandboxed, which may
 * refuse. Then OSC 52 through the terminal (a multiplexer may drop it), unless the host
 * refused: a sandboxed application's OSC 52 never reaches the clipboard anyway.
 */
export async function copy(renderer: CliRenderer, text: string) {
  try {
    await host.clipboard.write(text);
    return true;
  } catch (error: unknown) {
    if (error instanceof CapabilityDenied) return false;
  }
  return renderer.isOsc52Supported() && renderer.copyToClipboardOSC52(text);
}
