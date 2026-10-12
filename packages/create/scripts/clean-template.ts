import { rm } from "node:fs/promises";
import { join } from "node:path";

// The tarball holds the template; the checkout stages a fresh one on the next pack.
await rm(join(import.meta.dir, "../template"), { recursive: true, force: true });
