import { generatePublisherKey, publisherIdentity, readPublisherKey } from "../publisher";
import type { Command } from "./command";

/**
 * The publisher key that signs application bundles (`airtty build --sign-bundle`): its
 * fingerprint, which hosts pin, or a new one. Not the macOS Developer ID (`--sign`).
 */
export const keys: Command = {
  usage: "keys [generate]",
  run({ args }) {
    const identity =
      args[1] === "generate" ? generatePublisherKey() : publisherIdentity(readPublisherKey());
    console.log(
      `publisher key  ${identity.file}\nfingerprint    ${identity.fingerprint}\npublic key     ${identity.publicKey}`,
    );
    return Promise.resolve();
  },
};
