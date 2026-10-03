import { z } from "zod";
import { WIRE_ETB_DECIMAL_PATTERN } from "@/lib/ledger/money";
import { validateBalancedPostings } from "@/lib/ledger/rules";

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

/**
 * Query string of `GET /api/ledger/entries`. Strict: an unknown parameter is a
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
      .optional()
  })
  .strict()
  .transform((value) => ({
    groupId: value.groupId,
    limit: value.limit ?? LEDGER_READ_DEFAULT_LIMIT
  }));

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

/** Query of `GET /api/ledger/invites` and `GET /api/ledger/members`. */
export const ledgerGroupQuerySchema = z.object({ groupId: uuidSchema }).strict();

/**
 * `POST /api/sync` bodies (the offline outbox drain and the chain pull share
 * one URL; the shapes are disjoint and both strict, so a body can only ever be
 * one of them). The push envelope carries an opaque `payload`: it is judged by
 * `ledgerEntryRequestSchema` per item, so one malformed draft is that item's
 * rejection and not the whole batch's 400.
 */
export const SYNC_PUSH_MAX_BATCH = 25;
export const SYNC_PULL_MAX_LIMIT = 500;

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
