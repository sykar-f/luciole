// zod/mini: the Client imports this module, and the classic API would add ~130 KB to it.
import * as z from "zod/mini";

/**
 * A pane's instance key (docs/EMBEDDING.md, O1): chosen by the host of several panes,
 * sent by the Client as `x-airtty-instance`, written by the Server in front of the Client
 * Reference ids of its answers. Short and plain: it travels on every request and names an
 * entry of the Server's bounded manifest cache.
 */
export const InstanceKey = z.string().check(z.regex(/^[a-z0-9-]{1,32}$/));
export const INSTANCE_HEADER = "x-airtty-instance";

const ClientManifest = z.record(z.string(), z.looseObject({ id: z.string() }));
// Keys come from Clients: the copies are bounded, the least recently used goes first. A
// host rarely shows more panes of one build than this; an evicted key is copied again.
const MANIFEST_COPIES = 64;
/**
 * The Server's Client manifest as each instance must receive it. React Flight writes
 * `manifest[reference].id` for every Client Reference, in the page's nested stream as in
 * the envelope: a copy whose ids carry `<key>@` is all a pane needs. Server Function ids
 * are not in it and do not change.
 */
export function instanceManifests(manifest: unknown) {
  // Read on the first pane's request: a Server no pane asks behaves as it always has.
  let base: z.infer<typeof ClientManifest> | undefined;
  const copies = new Map<string, Record<string, unknown>>();
  return (key: string | undefined): unknown => {
    if (key === undefined) return manifest;
    const cached = copies.get(key);
    if (cached) {
      copies.delete(key);
      copies.set(key, cached);
      return cached;
    }
    const copy = Object.fromEntries(
      Object.entries((base ??= ClientManifest.parse(manifest))).map(([reference, entry]) => [
        reference,
        { ...entry, id: `${key}@${entry.id}` },
      ]),
    );
    copies.set(key, copy);
    for (const oldest of copies.keys()) {
      if (copies.size <= MANIFEST_COPIES) break;
      copies.delete(oldest);
    }
    return copy;
  };
}
