import type { PayerChoices } from "./clientContribution";

/**
 * A per-device copy of a group's payer choices (members and draw cycles), so a
 * treasurer who is offline can still name a payer on a draft.
 *
 * A convenience, never an authority: it is read only when the live read could not
 * be made, the screen says the list is from the last time the device was online,
 * and the server (`record_ledger_entry_attribution_v1`) re-checks the member and
 * the cycle when the draft syncs. Keyed by group, so one group's members are never
 * offered for another. Storage can be blocked: every access is guarded.
 */

const KEY = "sened.payers.v1";

export type CachedPayerChoices = Extract<PayerChoices, { status: "ready" }>;

type Store = Readonly<Record<string, CachedPayerChoices>>;

function readStore(): Store {
  try {
    const raw = window.localStorage.getItem(KEY);
    const value = raw ? (JSON.parse(raw) as unknown) : null;
    return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Store) : {};
  } catch {
    return {};
  }
}

export function readCachedPayerChoices(groupId: string): CachedPayerChoices | null {
  const value = readStore()[groupId] as Partial<CachedPayerChoices> | undefined;
  if (!value || !Array.isArray(value.members) || !Array.isArray(value.cycles)) {
    return null;
  }
  return {
    status: "ready",
    members: value.members.filter((member) => typeof member?.userId === "string"),
    cycles: value.cycles.filter((cycle) => typeof cycle?.cycleId === "string"),
    cyclesLoaded: value.cyclesLoaded === true
  };
}

/**
 * Forget every cached payer list. Called when the signed-in identity ends or
 * changes: the lists name a group's members (and, for an owner, their emails), so
 * they must not outlive the session that was allowed to read them.
 */
export function clearCachedPayerChoices(): void {
  try {
    window.localStorage.removeItem(KEY);
  } catch {
    // Storage blocked: nothing was written either.
  }
}

export function writeCachedPayerChoices(groupId: string, choices: CachedPayerChoices): void {
  try {
    window.localStorage.setItem(KEY, JSON.stringify({ ...readStore(), [groupId]: choices }));
  } catch {
    // Best effort.
  }
}
