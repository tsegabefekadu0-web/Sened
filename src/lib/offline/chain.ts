import type { LedgerEntryLike, SyncDivergence, SyncDivergenceKind } from "./contract";

/**
 * Detecting two divergent append-only histories.
 *
 * ## Why there is no merge here
 *
 * Each ledger entry commits to `previousHash`. Change one entry and every hash
 * after it changes too, so two histories that share a sequence number but not a
 * hash describe *different events*, not two views of one. There is no
 * last-write-wins merge that is not a lie, and no three-way merge that does not
 * require rewriting history — which §12.2 forbids. The only correct outcome is
 * to notice the fork and put a person in front of it.
 *
 * ## Why nothing here hashes anything
 *
 * The server already publishes every `entryHash` and `previousHash`. Divergence
 * is a question about whether two *published* values agree, so comparing them is
 * complete — no recomputation needed. That matters because
 * `src/lib/ledger/canonical.ts` imports `node:crypto` and cannot ship to a
 * browser, and because A1 owns that file (§8.5). This module therefore never
 * re-derives a hash; it only reads them. A1's `verifyLedgerChain` still runs
 * server-side during a Wave 2 pull, where Node is available.
 */

export interface ChainLink {
  readonly sequence: string;
  readonly entryHash: string;
  readonly previousHash: string;
}

export type ChainRelation = "identical" | "server-ahead" | "local-ahead" | "diverged";

export interface ChainComparison {
  readonly relation: ChainRelation;
  /** Entries the two histories agree on, counted from sequence 1. */
  readonly commonPrefixLength: number;
  /** First disagreeing sequence as a decimal string. Null unless diverged. */
  readonly forkSequence: string | null;
  readonly localLastSequence: string;
  readonly serverLastSequence: string;
  readonly localLastHash: string | null;
  readonly serverLastHash: string | null;
  readonly detail: string;
}

export interface LocalChainInspection {
  readonly ok: boolean;
  readonly ordered: boolean;
  /** Where an internal `previousHash` link broke, when `ok` is false. */
  readonly brokenAtSequence: string | null;
  readonly detail: string | null;
}

function toBigIntOrNull(value: string): bigint | null {
  return /^[0-9]+$/.test(value) ? BigInt(value) : null;
}

function compareBig(a: string, b: string): number {
  const left = toBigIntOrNull(a);
  const right = toBigIntOrNull(b);
  if (left === null || right === null) {
    return a.localeCompare(b);
  }
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Check that a mirrored chain is internally consistent: gapless, ascending, and
 * each entry's `previousHash` equal to the entry before it.
 *
 * A break here is *local* damage — a corrupted mirror, a partially applied
 * transaction — and is reported separately from a server/local fork, because the
 * remedy is different.
 */
export function inspectLocalChain(chain: readonly ChainLink[]): LocalChainInspection {
  let previous: ChainLink | null = null;
  for (const link of chain) {
    const sequence = toBigIntOrNull(link.sequence);
    if (sequence === null) {
      return {
        ok: false,
        ordered: false,
        brokenAtSequence: link.sequence,
        detail: `Sequence "${link.sequence}" is not a decimal number`
      };
    }
    if (previous) {
      if (sequence <= (toBigIntOrNull(previous.sequence) ?? -1n)) {
        return {
          ok: false,
          ordered: false,
          brokenAtSequence: link.sequence,
          detail: `Sequence ${link.sequence} does not come after ${previous.sequence}`
        };
      }
      if (link.previousHash !== previous.entryHash) {
        return {
          ok: false,
          ordered: true,
          brokenAtSequence: link.sequence,
          detail: `The entry at sequence ${link.sequence} does not link to the entry before it`
        };
      }
    }
    previous = link;
  }
  return { ok: true, ordered: true, brokenAtSequence: null, detail: null };
}

export function toChainLink(entry: LedgerEntryLike | ChainLink): ChainLink {
  return { sequence: entry.sequence, entryHash: entry.entryHash, previousHash: entry.previousHash };
}

function headSummary(
  localLast: ChainLink | null,
  serverLastSequence: string,
  serverLastHash: string | null
): Pick<ChainComparison, "localLastSequence" | "serverLastSequence" | "localLastHash" | "serverLastHash"> {
  return {
    localLastSequence: localLast?.sequence ?? "0",
    serverLastSequence,
    localLastHash: localLast?.entryHash ?? null,
    serverLastHash
  };
}

/**
 * Compare a complete local chain with a complete server chain.
 *
 * The four outcomes, and what each means for a treasurer:
 *
 * - `identical`    — nothing to do.
 * - `server-ahead` — this device is simply behind. Fast-forward; **not** a
 *   conflict. Treating this as a conflict would cry wolf on every ordinary sync.
 * - `local-ahead`  — the local mirror holds sequences the server has never
 *   issued. An append-only ledger cannot un-issue an entry, so this is a fork.
 * - `diverged`     — the histories share a prefix and then differ. The fork
 *   point is the first sequence whose hash disagrees.
 */
export function compareChains(
  local: readonly ChainLink[],
  server: readonly ChainLink[]
): ChainComparison {
  const localBySequence = new Map(local.map((link) => [link.sequence, link]));
  const serverBySequence = new Map(server.map((link) => [link.sequence, link]));
  const localLast = local.length > 0 ? local[local.length - 1] ?? null : null;
  const serverLast = server.length > 0 ? server[server.length - 1] ?? null : null;
  const base = headSummary(localLast, serverLast?.sequence ?? "0", serverLast?.entryHash ?? null);

  const sequences = [...new Set([...localBySequence.keys(), ...serverBySequence.keys()])].sort(compareBig);

  let commonPrefixLength = 0;
  for (const sequence of sequences) {
    const localLink = localBySequence.get(sequence);
    const serverLink = serverBySequence.get(sequence);
    if (localLink && serverLink) {
      if (localLink.entryHash === serverLink.entryHash && localLink.previousHash === serverLink.previousHash) {
        commonPrefixLength += 1;
        continue;
      }
      return {
        ...base,
        relation: "diverged",
        commonPrefixLength,
        forkSequence: sequence,
        detail:
          `Sequence ${sequence} hashes to ${localLink.entryHash} on this device and ${serverLink.entryHash} on the server. ` +
          "Both cannot be the same event, and an append-only chain cannot be merged."
      };
    }
    if (!localLink && serverLink) {
      return {
        ...base,
        relation: "server-ahead",
        commonPrefixLength,
        forkSequence: null,
        detail: `This device is behind the server by ${server.length - commonPrefixLength} entries. Nothing conflicts.`
      };
    }
    if (localLink && !serverLink) {
      return {
        ...base,
        relation: "local-ahead",
        commonPrefixLength,
        forkSequence: sequence,
        detail:
          `Sequence ${sequence} exists on this device but the server has never issued it. ` +
          "An append-only ledger does not un-issue entries, so this is a fork."
      };
    }
  }

  if (local.length !== server.length) {
    return {
      ...base,
      relation: local.length > server.length ? "local-ahead" : "server-ahead",
      commonPrefixLength,
      forkSequence: null,
      detail:
        local.length > server.length
          ? "This device holds entries the server has never issued."
          : "This device is behind the server. Nothing conflicts."
    };
  }
  return {
    ...base,
    relation: "identical",
    commonPrefixLength,
    forkSequence: null,
    detail: "Both histories match."
  };
}

export interface ContinuationInput {
  /** Highest entry this device holds, or null when the mirror is empty. */
  readonly localHead: ChainLink | null;
  /** The head the server reported, or null when the group has no entries. */
  readonly serverHead: { readonly lastSequence: string; readonly lastHash: string } | null;
  /** First entry of the pull response, or null when the response was empty. */
  readonly firstIncoming: ChainLink | null;
  /** The whole local mirror, for the internal-integrity check. */
  readonly localChain: readonly ChainLink[];
}

/**
 * The check a paginated pull actually needs.
 *
 * Pulling only asks "do the server's new entries link onto the head I already
 * hold?". That single question catches every fork shape:
 *
 * - same height, different hash → the classic rewrite;
 * - server ahead but the new first entry does not link to our head → one of us
 *   is on a different chain;
 * - server behind us → it un-issued an entry, which append-only forbids;
 * - server ahead but returned nothing → a gap we cannot verify, which is not
 *   the same as "no change" and must not be reported as quiet.
 */
export function compareContinuation(input: ContinuationInput): ChainComparison {
  const localHead = input.localHead;
  const serverHead = input.serverHead;
  const serverSequence = serverHead?.lastSequence ?? "0";
  const serverHash = serverHead?.lastHash ?? null;
  const base = headSummary(localHead, serverSequence, serverHash);

  if (!localHead && (serverSequence === "0" || !serverHead)) {
    return { ...base, relation: "identical", commonPrefixLength: 0, forkSequence: null, detail: "Both sides are empty." };
  }
  if (!localHead) {
    return {
      ...base,
      relation: "server-ahead",
      commonPrefixLength: 0,
      forkSequence: null,
      detail: "This device has not mirrored this group yet, so it is starting from the server's history."
    };
  }
  if (!serverHead || serverSequence === "0") {
    return {
      ...base,
      relation: "local-ahead",
      commonPrefixLength: 0,
      forkSequence: localHead.sequence,
      detail:
        "This device holds entries the server reports no longer existing. " +
        "An append-only ledger cannot un-issue an entry, so this is a fork."
    };
  }

  const localSequence = toBigIntOrNull(localHead.sequence) ?? 0n;
  const remoteSequence = toBigIntOrNull(serverSequence) ?? 0n;

  if (localSequence === remoteSequence) {
    if (localHead.entryHash === serverHash) {
      return { ...base, relation: "identical", commonPrefixLength: Number(localSequence), forkSequence: null, detail: "Both sides are at the same head." };
    }
    return {
      ...base,
      relation: "diverged",
      commonPrefixLength: Number(localSequence > 0n ? localSequence - 1n : 0n),
      forkSequence: localHead.sequence,
      detail:
        `Both sides are at sequence ${localHead.sequence} but hash differently ` +
        `(${localHead.entryHash} here, ${serverHash} on the server). One of these histories is not this group's.`
    };
  }

  if (localSequence > remoteSequence) {
    return {
      ...base,
      relation: "local-ahead",
      commonPrefixLength: Number(remoteSequence),
      forkSequence: serverSequence,
      detail:
        `This device is at sequence ${localHead.sequence} while the server is at ${serverSequence}. ` +
        "The server is behind a chain it should have appended to."
    };
  }

  const first = input.firstIncoming;
  if (!first) {
    return {
      ...base,
      relation: "diverged",
      commonPrefixLength: Number(localSequence),
      forkSequence: (localSequence + 1n).toString(),
      detail:
        `The server is ahead at sequence ${serverSequence} but sent no entries, so the missing links ` +
        "cannot be checked. Treating that as 'no change' would hide a fork."
    };
  }
  if (first.previousHash === localHead.entryHash) {
    return {
      ...base,
      relation: "server-ahead",
      commonPrefixLength: Number(localSequence),
      forkSequence: null,
      detail: `This device is ${remoteSequence - localSequence} entries behind the server. Nothing conflicts.`
    };
  }
  return {
    ...base,
    relation: "diverged",
    commonPrefixLength: Number(localSequence),
    forkSequence: first.sequence,
    detail:
      `The server's entry at sequence ${first.sequence} links to ${first.previousHash}, but this device's head ` +
      `at sequence ${localHead.sequence} hashes to ${localHead.entryHash}. The two chains do not meet.`
  };
}

const DIVERGENCE_KIND_BY_RELATION: Readonly<
  Record<Exclude<ChainRelation, "identical" | "server-ahead">, SyncDivergenceKind>
> = {
  diverged: "hash-mismatch",
  "local-ahead": "height-mismatch"
};

/** `null` unless the comparison found a fork that a person must resolve. */
export function toDivergence(
  comparison: ChainComparison,
  input: { readonly groupId: string; readonly detectedAt: string; readonly localInspection?: LocalChainInspection }
): SyncDivergence | null {
  if (input.localInspection && !input.localInspection.ok) {
    return {
      kind: "local-chain-broken",
      detectedAt: input.detectedAt,
      groupId: input.groupId,
      commonPrefixLength: comparison.commonPrefixLength,
      forkSequence: input.localInspection.brokenAtSequence ?? comparison.forkSequence ?? "0",
      localLastSequence: comparison.localLastSequence,
      serverLastSequence: comparison.serverLastSequence,
      localLastHash: comparison.localLastHash,
      serverLastHash: comparison.serverLastHash,
      detail: `The local mirror is damaged: ${input.localInspection.detail ?? "unknown"}. It has not been repaired or deleted.`,
      resolution: null,
      resolvedAt: null
    };
  }
  if (comparison.relation === "identical" || comparison.relation === "server-ahead") {
    return null;
  }
  return {
    kind: DIVERGENCE_KIND_BY_RELATION[comparison.relation],
    detectedAt: input.detectedAt,
    groupId: input.groupId,
    commonPrefixLength: comparison.commonPrefixLength,
    forkSequence: comparison.forkSequence ?? comparison.localLastSequence,
    localLastSequence: comparison.localLastSequence,
    serverLastSequence: comparison.serverLastSequence,
    localLastHash: comparison.localLastHash,
    serverLastHash: comparison.serverLastHash,
    detail: comparison.detail,
    resolution: null,
    resolvedAt: null
  };
}

/** `null` means "no fork". Anything else is a `SyncDivergence` for a person. */
export function detectDivergence(input: {
  readonly groupId: string;
  readonly detectedAt: string;
  readonly local: readonly (LedgerEntryLike | ChainLink)[];
  readonly server: readonly (LedgerEntryLike | ChainLink)[];
}): SyncDivergence | null {
  const localLinks = input.local.map(toChainLink);
  return toDivergence(compareChains(localLinks, input.server.map(toChainLink)), {
    groupId: input.groupId,
    detectedAt: input.detectedAt,
    localInspection: inspectLocalChain(localLinks)
  });
}

/** True while a fork is unresolved: pushes must stop until a person decides. */
export function blocksPush(divergence: SyncDivergence | null): boolean {
  return divergence !== null && divergence.resolution === null;
}
