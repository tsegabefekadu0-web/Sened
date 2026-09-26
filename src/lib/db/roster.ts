import { addEtbAmounts, formatEtbAmount, sumEtbAmounts } from "@/lib/ledger/money";
import { SyncError } from "@/lib/offline/contract";
import { mapStorageError } from "./database";
import { newLocalId } from "./ids";
import type { SenedDatabase } from "./schema";
import { ROSTER_ROLES, ROSTER_STATUSES, type RosterMemberRow, type RosterRole, type RosterStatus } from "./types";

const MAX_DISPLAY_NAME_LENGTH = 120;
const MAX_PHONE_LENGTH = 32;

export interface SaveRosterMemberInput {
  readonly id?: string;
  readonly groupId: string;
  readonly displayName: string;
  readonly phone?: string | null;
  readonly role?: RosterRole;
  readonly status?: RosterStatus;
  /** Contributions recorded on this device. Canonicalised before storage. */
  readonly contributedEtbOnDevice?: string;
  readonly joinedAt?: string;
  readonly updatedBy: string;
  readonly now?: Date;
}

function requireText(value: unknown, field: string, max: number): string {
  if (typeof value !== "string") {
    throw new SyncError("SYNC_CORRUPT_PAYLOAD", `${field} must be text`);
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new SyncError("SYNC_CORRUPT_PAYLOAD", `${field} must not be empty`);
  }
  if (trimmed.length > max) {
    throw new SyncError("SYNC_CORRUPT_PAYLOAD", `${field} must be at most ${max} characters`);
  }
  return trimmed;
}

function requireEnum<T extends string>(value: unknown, allowed: readonly T[], field: string, fallback: T): T {
  if (value === undefined || value === null) {
    return fallback;
  }
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new SyncError("SYNC_CORRUPT_PAYLOAD", `${field} is not a recognised value`);
  }
  return value as T;
}

function canonicalAmount(value: unknown, field: string): string {
  if (value === undefined || value === null) {
    return "0.00";
  }
  try {
    return formatEtbAmount(String(value));
  } catch (error) {
    throw new SyncError("SYNC_CORRUPT_PAYLOAD", `${field} is not a valid ETB amount`, { cause: error });
  }
}

/**
 * Insert or update a roster member.
 *
 * Upsert is keyed on the local row id, and `revision` only ever increments. A
 * pull that arrives out of order therefore cannot silently roll a member
 * backwards — see `applyRosterPull`, which is the only other writer.
 */
export async function saveRosterMember(
  db: SenedDatabase,
  input: SaveRosterMemberInput
): Promise<RosterMemberRow> {
  const groupId = requireText(input.groupId, "groupId", 64);
  const displayName = requireText(input.displayName, "displayName", MAX_DISPLAY_NAME_LENGTH);
  const updatedBy = requireText(input.updatedBy, "updatedBy", 64);
  const phone =
    input.phone === undefined || input.phone === null || input.phone.trim().length === 0
      ? null
      : requireText(input.phone, "phone", MAX_PHONE_LENGTH);
  const now = (input.now ?? new Date()).toISOString();
  const id = input.id ?? newLocalId();

  try {
    return await db.transaction("rw", db.roster, async () => {
      const existing = await db.roster.get(id);
      const row: RosterMemberRow = {
        id,
        groupId,
        displayName,
        phone,
        role: requireEnum(input.role, ROSTER_ROLES, "role", existing?.role ?? "member"),
        status: requireEnum(input.status, ROSTER_STATUSES, "status", existing?.status ?? "active"),
        contributedEtbOnDevice: canonicalAmount(
          input.contributedEtbOnDevice,
          "contributedEtbOnDevice"
        ),
        joinedAt: input.joinedAt ?? existing?.joinedAt ?? now,
        updatedAt: now,
        updatedBy,
        revision: (existing?.revision ?? 0) + 1
      };
      await db.roster.put(row);
      return row;
    });
  } catch (error) {
    throw mapStorageError(error, "Saving a roster member");
  }
}

export async function getRosterMember(
  db: SenedDatabase,
  id: string
): Promise<RosterMemberRow | undefined> {
  return db.roster.get(id);
}

export async function listRoster(db: SenedDatabase, groupId: string): Promise<RosterMemberRow[]> {
  const rows = await db.roster.where("groupId").equals(groupId).toArray();
  return rows.sort((left, right) => left.displayName.localeCompare(right.displayName));
}

export interface RosterTotalsOnDevice {
  readonly memberCount: number;
  readonly activeMemberCount: number;
  /**
   * Money this device has recorded but the server has not confirmed. The
   * console must label it as uncommitted — it is not a ledger balance.
   */
  readonly contributedEtbOnDevice: string;
}

/**
 * Totals derived **only** from local rows.
 *
 * There is no server read here by design. Anything that mixed a mirror entry
 * into this number would be claiming a balance the server never issued.
 */
export async function rosterTotalsOnDevice(
  db: SenedDatabase,
  groupId: string
): Promise<RosterTotalsOnDevice> {
  const rows = await listRoster(db, groupId);
  return {
    memberCount: rows.length,
    activeMemberCount: rows.filter((row) => row.status === "active").length,
    contributedEtbOnDevice: sumEtbAmounts(rows.map((row) => row.contributedEtbOnDevice))
  };
}

/**
 * Add a contribution the treasurer just spoke or typed.
 *
 * Uses the ledger's own bigint ETB arithmetic, so the running total cannot
 * drift by a cent and cannot overflow the way `parseFloat` would.
 */
export async function addOnDeviceContribution(
  db: SenedDatabase,
  memberId: string,
  amount: string,
  options: { readonly now?: Date } = {}
): Promise<RosterMemberRow> {
  const now = (options.now ?? new Date()).toISOString();
  try {
    return await db.transaction("rw", db.roster, async () => {
      const existing = await db.roster.get(memberId);
      if (!existing) {
        throw new SyncError("LOCAL_RECORD_NOT_FOUND", "Roster member was not found on this device");
      }
      let total: string;
      try {
        total = addEtbAmounts(existing.contributedEtbOnDevice, canonicalAmount(amount, "amount"));
      } catch (error) {
        throw new SyncError("SYNC_CORRUPT_PAYLOAD", "Contribution amount is not a valid ETB amount", {
          cause: error
        });
      }
      const row: RosterMemberRow = {
        ...existing,
        contributedEtbOnDevice: total,
        updatedAt: now,
        revision: existing.revision + 1
      };
      await db.roster.put(row);
      return row;
    });
  } catch (error) {
    if (error instanceof SyncError) {
      throw error;
    }
    throw mapStorageError(error, "Recording an on-device contribution");
  }
}
