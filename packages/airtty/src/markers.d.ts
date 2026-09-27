// `import "server-only"` and `import "client-only"` only mark the side a module runs on
// (docs/BOUNDARIES.md). The build resolves them to empty modules, so an application needs
// no package for them; `airtty/tsconfig` includes these declarations for its type checks.
declare module "server-only";
declare module "client-only";
// Files imported `with { type: "file" }` (src/grammars.ts): the path of the copy the
// bundler places next to the bundle, or of the file itself when run from source.
declare module "*.wasm" {
  const path: string;
  export default path;
}
declare module "*.scm" {
  const path: string;
  export default path;
}
