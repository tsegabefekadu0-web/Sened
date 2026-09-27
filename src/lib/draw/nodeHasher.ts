import { createHash } from "node:crypto";

import type { DrawHasher } from "./types";

/**
 * The Node half of the hashing seam.
 *
 * This lives apart from `canonical.ts` on purpose. `canonical.ts` is imported by
 * `DrawBoard.tsx`, a client component, and webpack refuses to bundle the `node:`
 * scheme into a browser target — so a top-level `import { createHash } from
 * "node:crypto"` there meant `/draw` could not be built at all, even though the
 * page itself only ever calls `webDrawHasher`.
 *
 * Nothing in the browser bundle may reach this file. The verification a member
 * performs on their own phone runs through `webDrawHasher` and WebCrypto, which
 * is the whole point: the server is not in that path.
 */

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** Node implementation of the hashing seam, for the server and the test suite. */
export const nodeDrawHasher: DrawHasher = async (data: string) => sha256Hex(data);
