// What the published packages export without a reference row or a README entry.
// tests/docs-exports.test.ts lists every name of every entry and needs each one documented
// (website/src/content/docs/reference/** for core and luciole.sh, the package's README for
// the others), or named here. A name is written `<import specifier>#<name>`.

/** The launcher's and the Server's own reading of `app/args.ts`: an app calls `defineArgs`. */
const launchPlumbing =
  "The launcher and the Server parse `app/args.ts` with it; an app calls `defineArgs`.";
/** The build's own steps, which share the entry file with `build()`. */
const buildStep = "A step of `build()`, run by the build itself; a host calls `build()`.";
/** Functions of the editor's model that `export type *` hands over as types, never as values. */
const modelHelper =
  "The editor's own helper over a `Block`; `export type *` exports it as a type, never as a value.";

/** Exported, but not for apps: each name gives why it stays out of the docs. */
export const internalExports: Readonly<Record<string, string>> = {
  "@luciole-sh/core/args#grammar": launchPlumbing,
  "@luciole-sh/core/args#Flag": launchPlumbing,
  "@luciole-sh/core/args#suggest": launchPlumbing,
  "@luciole-sh/core/args#tokenize": launchPlumbing,
  "@luciole-sh/core/args#isArgsDefinition": launchPlumbing,
  "@luciole-sh/core/args#markServer":
    "The Server's preload marks its process with it, before the app's modules load.",
  "@luciole-sh/core/args#configureArgs":
    "The Server parses its launch with it once; an app reads the result with `get()`.",
  "@luciole-sh/core/args#configuredArgs":
    "The Server's own state behind `get()`; an app reads `get()`.",
  "@luciole-sh/core/args#argsFingerprint": "A part of a Server's key, which the launcher computes.",
  "@luciole-sh/core/args#LaunchArgs":
    "The format of `LUCIOLE_ARGS` between a launch and its Server; the environment page documents the variable.",
  "@luciole-sh/core/args#ARGS_VARIABLE":
    "The name `LUCIOLE_ARGS`, which the environment page documents as a variable.",
  "@luciole-sh/core/args#encodeLaunchArgs":
    "A launch writes `LUCIOLE_ARGS` with it; an app never does.",
  "@luciole-sh/core/args#decodeLaunchArgs":
    "The Server reads `LUCIOLE_ARGS` with it; an app never does.",
  "@luciole-sh/core/build#ARGS_FILE":
    "The path `app/args.ts`, which the app-arguments page names as a file.",
  "@luciole-sh/core/build#publish": buildStep,
  "@luciole-sh/core/metadata#readAppDeclaration": buildStep,
  "@luciole-sh/core/metadata#writeAppMetadata": buildStep,
  "@luciole-sh/core/metadata#AppDeclaration":
    "The type of `readAppDeclaration`, a step of `build()`.",
  "@luciole-sh/markdown-editor#isText": modelHelper,
  "@luciole-sh/markdown-editor#isLines": modelHelper,
  "@luciole-sh/markdown-editor#quoteOf": modelHelper,
  "@luciole-sh/markdown-editor#levelOf": modelHelper,
};

/**
 * The API families that document the rest, each emptied by its own mission: the three of
 * core's reference, and `libraries` for the READMEs of flow-graph and markdown-editor.
 */
export type ApiFamily = "client" | "server-and-cache" | "hosts-and-tools" | "libraries";

/**
 * Names documented nowhere today, by the family that will document them. The list is a
 * ratchet: once a page documents a name, the test fails until the name leaves this list.
 */
export const pendingExports: Readonly<Record<ApiFamily, readonly string[]>> = {
  client: [
    "@luciole-sh/core/client#CapabilityState",
    "@luciole-sh/core/client#EmbedProps",
    "@luciole-sh/core/client#Fault",
    "@luciole-sh/core/client#Fetch",
    "@luciole-sh/core/client#FieldInputProps",
    "@luciole-sh/core/client#FieldScrollBoxProps",
    "@luciole-sh/core/client#FieldTextareaProps",
    "@luciole-sh/core/client#GlobalKey",
    "@luciole-sh/core/client#Host",
    "@luciole-sh/core/client#MarkdownPalette",
    "@luciole-sh/core/client#MarkdownProps",
    "@luciole-sh/core/client#NetworkConditions",
    "@luciole-sh/core/client#Outcome",
    "@luciole-sh/core/client#RequestCause",
    "@luciole-sh/core/client#RequestContext",
    "@luciole-sh/core/client#RestoredFields",
    "@luciole-sh/core/client#RouteParams",
    "@luciole-sh/core/client#RouteSearch",
    "@luciole-sh/core/client#TerminalProps",
    "@luciole-sh/core/client#TerminalViewProps",
    "@luciole-sh/core/client#Transport",
    "@luciole-sh/core/client#TransportEvent",
  ],
  "server-and-cache": [
    "@luciole-sh/core/server#CacheProfile",
    "@luciole-sh/core/server#HandlerOptions",
    "@luciole-sh/core/server#RouteAuth",
    "@luciole-sh/core/server#ServerConfig",
    "@luciole-sh/core/server#ServerFunction",
    "@luciole-sh/core/server#ServerInstrument",
    "@luciole-sh/core/server#ServerRoute",
  ],
  "hosts-and-tools": [
    "@luciole-sh/core/client#HostChannel",
    "@luciole-sh/core/client#HostEvent",
    "@luciole-sh/core/client#HostRequest",
    "@luciole-sh/core/client#MediatedCapability",
    "@luciole-sh/core/route-tree#TerminalRouter",
    "@luciole-sh/core/route-tree#TerminalRouterContext",
    "@luciole-sh/core/args#ArgsDefinition",
    "@luciole-sh/core/args#ArgsError",
    "@luciole-sh/core/args#ArgsSchema",
    "@luciole-sh/core/args#ArgsSpec",
    "@luciole-sh/core/args#HelpOptions",
    "@luciole-sh/core/args#isUsageError",
    "@luciole-sh/core/args#ParseContext",
    "@luciole-sh/core/args#RESERVED_FLAGS",
    "@luciole-sh/core/args#RESERVED_SHORTS",
    "@luciole-sh/core/args#StandardJsonSchema",
    "@luciole-sh/core/args#StandardSchema",
    "@luciole-sh/core/args#USAGE_EXIT_CODE",
    "@luciole-sh/core/build#BuildOptions",
    "@luciole-sh/core/build#fingerprintOf",
    "@luciole-sh/core/build#generatePublisherKey",
    "@luciole-sh/core/build#PublisherKey",
    "@luciole-sh/core/build#readPublisherKey",
    "@luciole-sh/core/dev#AppServer",
    "@luciole-sh/core/dev#AppServerOptions",
    "@luciole-sh/core/dev#frameworkModules",
    "@luciole-sh/core/pty#Pty",
    "@luciole-sh/core/pty#PtyOptions",
    "@luciole-sh/core/sandbox#Availability",
    "@luciole-sh/core/sandbox#buildChild",
    "@luciole-sh/core/sandbox#Capabilities",
    "@luciole-sh/core/sandbox#enforcement",
    "@luciole-sh/core/sandbox#ENFORCERS",
    "@luciole-sh/core/sandbox#freeLoopbackPort",
    "@luciole-sh/core/sandbox#Mechanism",
    "@luciole-sh/core/sandbox#mechanismName",
    "@luciole-sh/core/sandbox#Sandbox",
    "@luciole-sh/core/sandbox#SandboxOptions",
    "@luciole-sh/core/sandbox#SandboxOrigin",
    "@luciole-sh/core/sandbox#sandboxRuntime",
    "@luciole-sh/core/sandbox#ServerSandbox",
    "@luciole-sh/core/sandbox#ServerSandboxOptions",
    "@luciole-sh/core/sandbox#TerminalIo",
    "@luciole-sh/core/metadata#APP_ICON",
    "@luciole-sh/core/metadata#APP_METADATA",
    "@luciole-sh/core/metadata#AppArgs",
    "@luciole-sh/core/metadata#readAppMetadata",
  ],
  libraries: [
    "@luciole-sh/flow-graph#AddChange",
    "@luciole-sh/flow-graph#BackgroundVariant",
    "@luciole-sh/flow-graph#Connection",
    "@luciole-sh/flow-graph#Detail",
    "@luciole-sh/flow-graph#detailFor",
    "@luciole-sh/flow-graph#EdgeChange",
    "@luciole-sh/flow-graph#EdgeStyle",
    "@luciole-sh/flow-graph#EdgeType",
    "@luciole-sh/flow-graph#fitViewport",
    "@luciole-sh/flow-graph#flowBounds",
    "@luciole-sh/flow-graph#FlowInstance",
    "@luciole-sh/flow-graph#FlowProps",
    "@luciole-sh/flow-graph#FlowTheme",
    "@luciole-sh/flow-graph#Frame",
    "@luciole-sh/flow-graph#getEdgeId",
    "@luciole-sh/flow-graph#HandleSpec",
    "@luciole-sh/flow-graph#HandleType",
    "@luciole-sh/flow-graph#MarkerType",
    "@luciole-sh/flow-graph#NodeChange",
    "@luciole-sh/flow-graph#NodeComponent",
    "@luciole-sh/flow-graph#NodeDimensionsChange",
    "@luciole-sh/flow-graph#NodePositionChange",
    "@luciole-sh/flow-graph#Position",
    "@luciole-sh/flow-graph#Rect",
    "@luciole-sh/flow-graph#RemoveChange",
    "@luciole-sh/flow-graph#ReplaceChange",
    "@luciole-sh/flow-graph#SelectionChange",
    "@luciole-sh/markdown-editor#Block",
    "@luciole-sh/markdown-editor#Doc",
    "@luciole-sh/markdown-editor#HeadingLevel",
    "@luciole-sh/markdown-editor#Inline",
    "@luciole-sh/markdown-editor#LinesBlock",
    "@luciole-sh/markdown-editor#ListKind",
    "@luciole-sh/markdown-editor#ListMarker",
    "@luciole-sh/markdown-editor#MarkdownEditorProps",
    "@luciole-sh/markdown-editor#MarkName",
    "@luciole-sh/markdown-editor#Marks",
    "@luciole-sh/markdown-editor#Place",
    "@luciole-sh/markdown-editor#Pos",
    "@luciole-sh/markdown-editor#RuleBlock",
    "@luciole-sh/markdown-editor#Selection",
    "@luciole-sh/markdown-editor#Span",
    "@luciole-sh/markdown-editor#TextBlock",
  ],
};
