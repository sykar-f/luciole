// `import "server-only"` and `import "client-only"` only mark the side a module runs on
// (docs/BOUNDARIES.md). The build resolves them to empty modules, so an application needs
// no package for them; `airtty/tsconfig` includes these declarations for its type checks.
declare module "server-only";
declare module "client-only";
