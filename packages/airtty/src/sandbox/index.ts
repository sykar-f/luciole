/**
 * `airtty/sandbox`: the `sandbox` mode of docs/EMBEDDING.md for a host outside the
 * framework (studio's preview): a confined Client on a PTY shown by the VT widget, its
 * mediated capabilities over IPC, and a confined Server. No component: the widget that
 * shows a sandboxed Client is `TerminalView` of airtty/client. The generic Client uses
 * the same modules from inside the framework.
 */
export { openSandbox } from "./spawn";
export type { Sandbox, SandboxOptions, SandboxOrigin } from "./spawn";
export { confineServer, freeLoopbackPort } from "./server";
export type { ServerSandbox, ServerSandboxOptions } from "./server";
export { buildChild, sandboxAvailability, sandboxRuntime } from "./runtime";
export { enforcement, ENFORCERS } from "./grants";
export { mechanismName } from "./mechanism";
export type { Availability, Mechanism } from "./mechanism";
export { Capabilities } from "../capabilities";
export type { TerminalIo } from "../vt/terminal";
