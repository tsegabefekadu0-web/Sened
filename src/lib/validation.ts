import { z } from "zod";
import { WIRE_ETB_DECIMAL_PATTERN } from "@/lib/ledger/money";
import { validateBalancedPostings } from "@/lib/ledger/rules";
import { CONTRIBUTION_CHANNELS, checkContributionNote } from "@/lib/ledger/paymentChannel";

const uuidSchema = z.string().uuid().transform((value) => value.toLowerCase());
const amountSchema = z
  .string()
  .max(21)
  .regex(WIRE_ETB_DECIMAL_PATTERN, "Invalid ETB amount")
  .refine((value) => !/^0\.00$/.test(value), "Amount must be positive");

export const ledgerPostingSchema = z
  .object({
    accountId: uuidSchema,
    direction: z.enum(["debit", "credit"]),
    amount: amountSchema
  })
  .strict();

export const ledgerEntryRequestSchema = z
  .object({
    groupId: uuidSchema,
    idempotencyKey: z
      .string()
      .trim()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/),
    occurredAt: z
      .string()
      .max(35)
      .datetime({ offset: true })
      .transform((value) => new Date(value).toISOString()),
    entryType: z.enum(["journal", "contribution", "disbursement", "adjustment", "correction"]),
    correctsEntryId: uuidSchema.optional(),
    rationale: z.string().trim().min(10).max(1000).optional(),
    postings: z.array(ledgerPostingSchema).min(2).max(100)
  })
  .strict()
  .superRefine((value, context) => {
    const year = new Date(value.occurredAt).getUTCFullYear();
    if (year < 1900 || year > 2100) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["occurredAt"],
        message: "Timestamp is outside the supported range"
      });
    }
    if (value.entryType === "correction") {
      if (!value.correctsEntryId) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["correctsEntryId"],
          message: "Correction target is required"
        });
      }
      if (!value.rationale) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["rationale"],
          message: "Correction rationale is required"
        });
      }
    } else if (value.correctsEntryId !== undefined || value.rationale !== undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["correctsEntryId"],
        message: "Only corrections may reference another entry"
      });
    }
    try {
      validateBalancedPostings(value.postings);
    } catch {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["postings"],
        message: "Postings must balance"
      });
    }
  });

export const LEDGER_READ_DEFAULT_LIMIT = 50;
export const LEDGER_READ_MAX_LIMIT = 100;
/** `ledger_entries.sequence` is a Postgres bigint. */
const LEDGER_SEQUENCE_MAX = 9_223_372_036_854_775_807n;

/**
 * Query string of `GET /api/ledger/entries` (`groupId`, optional `limit` and
 * optional `beforeSequence` cursor). Strict: an unknown parameter is a
 * 400, not ignored, so a client cannot believe it filtered by something the
 * server never looked at. A repeated parameter arrives as an array and fails.
 */
export const ledgerEntriesQuerySchema = z
  .object({
    groupId: uuidSchema,
    limit: z
      .string()
      .regex(/^[1-9]\d{0,2}$/)
      .transform((value) => Number(value))
      .refine((value) => value <= LEDGER_READ_MAX_LIMIT, "limit is too large")
      .optional(),
    // Cursor: only entries with a smaller sequence are returned. A positive
    // bigint in canonical decimal form (no sign, no leading zero, no exponent),
    // so the value the server compares is exactly the value the client sent.
    beforeSequence: z
      .string()
      .regex(/^[1-9]\d{0,18}$/)
      // zod runs every check, so the shape is re-tested before BigInt() sees the value.
      .refine((value) => !/^[1-9]\d{0,18}$/.test(value) || BigInt(value) <= LEDGER_SEQUENCE_MAX, "beforeSequence is too large")
      .optional()
  })
.strict()
  .transform((value) => ({
    groupId: value.groupId,
    limit: value.limit ?? LEDGER_READ_DEFAULT_LIMIT,
    beforeSequence: value.beforeSequence ?? null
  }));

/** Query of `GET /api/ledger/balances`. Strict, like every ledger read. */
export const ledgerBalancesQuerySchema = z.object({ groupId: uuidSchema }).strict();

/**
 * `POST /api/ledger/member-roles` body. Strict: a smuggled `tenantId` or an
 * `owner` role is a 400, not ignored. Only `treasurer` (grant) and `member`
 * (clear) can be requested; ownership is never assigned through this route.
 */
export const ledgerMemberRoleRequestSchema = z
  .object({
    groupId: uuidSchema,
    userId: uuidSchema,
    role: z.enum(["treasurer", "member"])
  })
  .strict();

/**
 * A member's own avatar attire. The body names the group and the value only: the
 * member is whoever the session says, never a field here, and `.strict()` turns
 * a `userId` smuggled into the body into a 400 rather than ignoring it.
 */
export const MEMBER_ATTIRE_VALUES = ["none", "gabi", "netela"] as const;
export const ledgerMemberAttireRequestSchema = z
  .object({
    groupId: uuidSchema,
    attire: z.enum(MEMBER_ATTIRE_VALUES)
  })
  .strict();

/**
 * Who paid a contribution that did not come through a bank verification. The
 * payer is named by the treasurer (`memberUserId`); who is RECORDING it is never a
 * field, it is the session. `cycleId` and `round` say which round the payment is
 * for, optionally; a round needs its cycle. All strict, so a smuggled `recordedBy`
 * or `source` is a 400, not ignored.
 *
 * `ledgerEntryAttributionSchema` is the part that rides along on a ledger entry
 * post (`POST /api/ledger/entries`, `attribution`): the entry id is not known yet.
 */
const attributionRoundSchema = z.number().int().min(1).max(1000);
/**
 * How it was paid and a short plain-text note (see `paymentChannel.ts`). Both are
 * optional and nullable: absent = not given, `null` = none. On a correction (PUT)
 * absent KEEPS the earlier value and `null` clears it. The note is trimmed first and
 * a blank one is a 400 (clients leave the field out instead).
 */
const attributionChannelSchema = z.enum(CONTRIBUTION_CHANNELS);
const attributionNoteSchema = z
  .string()
  .trim()
  .min(1)
  .refine((value) => checkContributionNote(value).ok, "A note is 1 to 280 characters of plain text, without control characters");
const attributionShape = {
  memberUserId: uuidSchema,
  cycleId: uuidSchema.optional(),
  round: attributionRoundSchema.optional(),
  channel: attributionChannelSchema.nullable().optional(),
  note: attributionNoteSchema.nullable().optional()
};
function roundNeedsCycle(value: { cycleId?: string; round?: number }, context: z.RefinementCtx): void {
  if (value.round !== undefined && value.cycleId === undefined) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["round"], message: "A round needs its cycle" });
  }
}
export const ledgerEntryAttributionSchema = z.object(attributionShape).strict().superRefine(roundNeedsCycle);

export const ledgerAttributionRecordRequestSchema = z
  .object({ groupId: uuidSchema, entryId: uuidSchema, ...attributionShape })
  .strict()
  .superRefine(roundNeedsCycle);

export const ledgerAttributionSupersedeRequestSchema = z
  .object({
    groupId: uuidSchema,
    entryId: uuidSchema,
    ...attributionShape,
    reason: z.string().trim().min(10).max(1000)
  })
  .strict()
  .superRefine(roundNeedsCycle);

/**
 * Invite links. All strict. Expiry is capped at 30 days and uses at 50, which
 * the SQL enforces again; a wrong value is a 400 here rather than a database
 * error. The token schema is a shape check only (the database decides whether
 * it matches an invite) and the token must never be echoed back.
 */
export const INVITE_DEFAULT_EXPIRES_HOURS = 168;
export const INVITE_MAX_EXPIRES_HOURS = 720;
export const INVITE_DEFAULT_MAX_USES = 1;
export const INVITE_MAX_USES = 50;

export const ledgerInviteCreateRequestSchema = z
  .object({
    groupId: uuidSchema,
    expiresInHours: z.number().int().min(1).max(INVITE_MAX_EXPIRES_HOURS).optional(),
    maxUses: z.number().int().min(1).max(INVITE_MAX_USES).optional()
  })
  .strict()
  .transform((value) => ({
    groupId: value.groupId,
    expiresInHours: value.expiresInHours ?? INVITE_DEFAULT_EXPIRES_HOURS,
    maxUses: value.maxUses ?? INVITE_DEFAULT_MAX_USES
  }));

export const ledgerInviteRedeemRequestSchema = z
  .object({ token: z.string().min(16).max(256).regex(/^[A-Za-z0-9_-]+$/) })
  .strict();

export const ledgerInviteRevokeRequestSchema = z.object({ inviteId: uuidSchema }).strict();

/**
 * Draw cycles and the member side of a draw. All strict: an unknown field is a
 * 400, so a client cannot believe it chose something the server reads from the
 * database (the roster, the pot, which member a seal belongs to).
 *
 * `POST /api/draw/seals` and `POST /api/draw/nonces` carry NO member id. The
 * member is the signed-in user, resolved in the database from `auth.uid()`; a body
 * that names one is rejected here before it reaches the database.
 */
const drawHex64Schema = z.string().regex(/^[0-9a-f]{64}$/, "Expected a 64-character lowercase SHA-256 digest");
const drawEntropySchema = z
  .string()
  .min(16)
  .max(256)
  .refine((value) => /^[!-~]+$/.test(value), "Entropy must be printable ASCII");
const drawIdempotencyKeySchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);

export const drawCycleCreateRequestSchema = z
  .object({
    groupId: uuidSchema,
    name: z.string().trim().min(1).max(120),
    contributionAmount: amountSchema,
    totalRounds: z.number().int().min(1).max(1000),
    reserveRatioBps: z.number().int().min(0).max(3333),
    startedAt: z
      .string()
      .max(35)
      .datetime({ offset: true })
      .transform((value) => new Date(value).toISOString())
      .optional(),
    idempotencyKey: drawIdempotencyKeySchema,
    /** The cycle's contribution gate (§18); `off` when absent. */
    contributionGate: z.enum(["off", "warn", "block"]).optional(),
    /** Hours after a draw opens before it may be cancelled for missing seals (1..720, default 48). */
    sealWindowHours: z.number().int().min(1).max(720).optional(),
    /** Hours after the commit before it may be cancelled for missing nonces (1..720, default 48). */
    nonceWindowHours: z.number().int().min(1).max(720).optional()
  })
  .strict();

/** A reason for an override or a policy change: 10..1000 characters once trimmed. */
const gateReasonSchema = z.string().trim().min(10).max(1000);

export const drawOpenRequestSchema = z
  .object({
    cycleId: uuidSchema,
    round: z.number().int().min(1).max(1000).optional(),
    idempotencyKey: drawIdempotencyKeySchema,
    /**
     * Only meaningful under a `block` gate: an owner/treasurer's recorded reason for
     * opening the draw although an active member has a flagged earlier round.
     */
    overrideReason: gateReasonSchema.optional(),
    /**
     * Re-opening a round after a cancel: leave out the members recorded as non-responders of
     * that round's earlier cancels. Only them; the database refuses it when there are none.
     */
    excludeMissed: z.boolean().optional()
  })
  .strict();

/** `POST /api/draw/gate`: owner/treasurer changes a cycle's contribution gate, with a reason. */
export const drawGateRequestSchema = z
  .object({
    cycleId: uuidSchema,
    gate: z.enum(["off", "warn", "block"]),
    reason: gateReasonSchema
  })
  .strict();

/** `GET /api/draw/contributions?cycleId=`: the members x rounds grid. */
export const drawContributionsQuerySchema = z.object({ cycleId: uuidSchema }).strict();

export const drawSealRequestSchema = z
  .object({ drawId: uuidSchema, sealed: drawHex64Schema })
  .strict();

export const drawNonceRequestSchema = z
  .object({ drawId: uuidSchema, nonce: drawEntropySchema })
  .strict();

/**
 * Collateral (M4.2). `GET /api/draw/collateral?cycleId=` reads the derived view;
 * `POST /api/draw/guarantees` carries one of five actions. All strict.
 *
 * No body ever names who is acting: the proposer, the guarantor answering and the
 * releaser are the signed-in user, resolved in the database from `auth.uid()`.
 * `accept` and `decline` take only the guarantee's id, so nobody can accept "as"
 * someone else. A reason is required to release or supersede (10..1000
 * characters) and optional on a decline.
 */
export const drawCollateralQuerySchema = z.object({ cycleId: uuidSchema }).strict();

const guaranteeReasonSchema = z.string().trim().min(10).max(1000);
export const drawGuaranteeRequestSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("propose"),
      cycleId: uuidSchema,
      winnerMemberId: uuidSchema,
      guarantorMemberId: uuidSchema
    })
    .strict(),
  z.object({ action: z.literal("accept"), guaranteeId: uuidSchema }).strict(),
  z
    .object({ action: z.literal("decline"), guaranteeId: uuidSchema, reason: z.string().trim().min(1).max(1000).optional() })
    .strict(),
  z.object({ action: z.literal("release"), guaranteeId: uuidSchema, reason: guaranteeReasonSchema }).strict(),
  z
    .object({
      action: z.literal("supersede"),
      guaranteeId: uuidSchema,
      newGuarantorMemberId: uuidSchema,
      reason: guaranteeReasonSchema
    })
    .strict()
]);

export const drawCycleIdSchema = uuidSchema;
export const drawSessionIdSchema = uuidSchema;

/** Query of `GET /api/ledger/invites` and `GET /api/ledger/members`. */
export const ledgerGroupQuerySchema = z.object({ groupId: uuidSchema }).strict();

/** Query of `GET /api/draw/cycles`. */
export const drawCycleListQuerySchema = ledgerGroupQuerySchema;

/**
 * `POST /api/sync` bodies (the offline outbox drain and the chain pull share
 * one URL; the shapes are disjoint and both strict, so a body can only ever be
 * one of them). The push envelope carries an opaque `payload`: it is judged by
 * `ledgerEntryRequestSchema` per item, so one malformed draft is that item's
 * rejection and not the whole batch's 400.
 */
export const SYNC_PUSH_MAX_BATCH = 25;
/** One pull page: small enough that its postings are read in a handful of requests. */
export const SYNC_PULL_MAX_LIMIT = 100;

const syncKeySchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);

export const syncPushEnvelopeSchema = z
  .object({
    mutationId: z.string().min(1).max(128),
    idempotencyKey: syncKeySchema,
    kind: z.enum(["ledger-draft", "spoken-note", "roster-member"]),
    groupId: uuidSchema,
    payload: z.unknown(),
    clientRecordedAt: z.string().max(35).datetime({ offset: true })
  })
  .strict();

export const syncPushRequestSchema = z
  .object({
    mutations: z.array(syncPushEnvelopeSchema).min(1).max(SYNC_PUSH_MAX_BATCH)
  })
  .strict()
  .superRefine((value, context) => {
    const seen = new Set<string>();
    value.mutations.forEach((mutation, index) => {
      if (seen.has(mutation.mutationId)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["mutations", index, "mutationId"],
          message: "Duplicate mutation id"
        });
      }
      seen.add(mutation.mutationId);
    });
  });

export const syncPullRequestSchema = z
  .object({
    groupId: uuidSchema,
    sinceSequence: z.string().regex(/^(0|[1-9]\d{0,17})$/),
    limit: z.number().int().min(1).max(SYNC_PULL_MAX_LIMIT)
  })
  .strict();

/**
 * `POST /api/governance/recommendations` body (M5.2). Strict, like every other
 * request schema here: an unknown field is a 400, so a client cannot believe it
 * tuned something the engine never read. Iddir-only figures are rejected on an
 * Equb for the same reason, and an Iddir must say what a claim costs, because
 * the engine refuses to invent that number. Advisory only: no group id, nothing
 * is persisted.
 */
const governanceMoneySchema = z.string().max(21).regex(WIRE_ETB_DECIMAL_PATTERN, "Invalid ETB amount");

export const governanceRecommendationRequestSchema = z
  .object({
    groupType: z.enum(["equb", "iddir"]),
    memberCount: z.number().int().min(2).max(500),
    contributionAmount: amountSchema,
    cycleLengthDays: z.number().int().min(1).max(366),
    trust: z.enum(["close", "mixed", "new"]),
    typicalClaimAmount: amountSchema.optional(),
    currentFundBalance: governanceMoneySchema.optional()
  })
  .strict()
  .superRefine((value, context) => {
    if (value.groupType === "iddir" && value.typicalClaimAmount === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["typicalClaimAmount"],
        message: "Required for an Iddir"
      });
    }
    if (value.groupType === "equb") {
      for (const field of ["typicalClaimAmount", "currentFundBalance"] as const) {
        if (value[field] !== undefined) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: [field],
            message: "Applies to an Iddir only"
          });
        }
      }
    }
  });

export type LedgerEntryRequestInput = z.input<typeof ledgerEntryRequestSchema>;
export type ValidatedLedgerEntryRequest = z.output<typeof ledgerEntryRequestSchema>;

export {
  bankVerificationRequestSchema,
  bankVerificationIdSchema,
  publicBankVerificationSchema
} from "@/lib/banking/schemas";

export type ParseResult<T> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly message: string };

export function parse<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, input: unknown): ParseResult<T> {
  const result = schema.safeParse(input);
  if (result.success) {
    return { ok: true, data: result.data };
  }
  const fields = Array.from(
    new Set(
      result.error.issues.flatMap((issue) => {
        if (issue.code === "unrecognized_keys") {
          return issue.keys;
        }
        const field = issue.path.join(".");
        return field.length > 0 ? [field] : [];
      })
    )
  );
  return {
    ok: false,
    message: fields.length > 0 ? `Invalid fields: ${fields.join(", ")}` : "Invalid request body"
  };
}

/**
 * `POST /api/draw/cancel`: owner/treasurer cancels a draw whose members did not respond. The reason
 * (10..1000 characters once trimmed) is recorded with who and when; the database decides whether the
 * deadline has passed. Amharic is 3 bytes a character, so a full reason fits the route's 8 KiB cap.
 */
export const drawCancelRequestSchema = z
  .object({
    drawId: uuidSchema,
    reason: gateReasonSchema
  })
  .strict();
