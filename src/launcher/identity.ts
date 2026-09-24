/** What a compiled app binary is: its app, its build and the platform it runs on. */
export type BinaryIdentity = { name: string; buildId: string; target: string };
// Written in the binary as a plain string literal (src/compile.ts), nothing a bundler
// would escape: found in its bytes, a foreign binary included, without running it.
const IDENTITY = /airtty-binary:1:([\w.-]+):([0-9a-f]+):(bun-[a-z0-9-]+);/;
export const formatIdentity = ({ name, buildId, target }: BinaryIdentity) =>
  `airtty-binary:1:${name}:${buildId}:${target};`;
export function parseIdentity(text: string): BinaryIdentity | undefined {
  const [, name, buildId, target] = IDENTITY.exec(text) ?? [];
  return name && buildId && target ? { name, buildId, target } : undefined;
}

/**
 * The identity of a binary made by `compileApp`, read from its bytes: a foreign target's
 * binary cannot be run here to ask it.
 */
export async function readBinaryIdentity(file: string): Promise<BinaryIdentity> {
  // latin1 maps each byte to one character: the literal is found wherever it lies.
  const identity = parseIdentity(Buffer.from(await Bun.file(file).bytes()).toString("latin1"));
  if (!identity) throw new Error(`${file} is not an airtty app binary`);
  return identity;
}
