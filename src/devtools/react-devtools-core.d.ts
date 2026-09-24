// react-devtools-core ships no declarations: the part the fiber hook (hook.ts) calls.
declare module "react-devtools-core" {
  const devtools: { initialize(): void; connectToDevTools(options?: unknown): void };
  export default devtools;
}
