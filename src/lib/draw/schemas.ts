import { z } from "zod";

import { DRAW_ROUND_STATES, DRAW_VERIFICATION_CODES } from "./types";

const uuidSchema = z.string().uuid().transform((value) => value.toLowerCase());

const timestampSchema = z
  .string()
  .max(35)
  .datetime({ offset: true })
  .transform((value) => new Date(value).toISOString());

const idempotencyKeySchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);

const entropySchema = z
  .string()
  .min(16)
  .max(256)
  .refine((value) => /^[!-~]+$/.test(value), "Entropy must be printable ASCII");

export const drawRoundStateSchema = z.enum(DRAW_ROUND_STATES);
export const drawVerificationCodeSchema = z.enum(DRAW_VERIFICATION_CODES);

/**
 * M4.1 step 1. The seed and the commitment nonce are generated on the
 * treasurer's device and sent here so the server can compute the commitment; both
 * are optional, the server fills them from a CSPRNG when absent, and anything
 * under 16 characters is refused either way.
 *
 * Everything else is deliberately NOT in this body. The roster, the pot, the
 * contribution, the reserve and the number of rounds come from the cycle and the
 * group as the database holds them, and the sealed set is whatever the members
 * stored with `POST /api/draw/seals`. Being `.strict()`, a body that still carries
 * `members`, `potAmount` or `memberCommitments` is a 400: a client must not
 * believe it chose them.
 */
export const drawCommitRequestSchema = z
  .object({
    drawId: uuidSchema,
    commitmentNonce: entropySchema.optional(),
    seed: entropySchema.optional(),
    idempotencyKey: idempotencyKeySchema,
    committedAt: timestampSchema.optional(),
    /**
     * Only meaningful under a `block` gate: an owner/treasurer's recorded reason for committing although
     * an active member has a flagged earlier round that the override given at open did not name.
     */
    overrideReason: z.string().trim().min(10).max(1000).optional()
  })
  .strict()
  .superRefine((value, context) => {
    if (value.commitmentNonce !== undefined && value.commitmentNonce === value.seed) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["commitmentNonce"],
        message: "The commitment nonce must differ from the seed"
      });
    }
  });

/**
 * M4.1 step 2. The reveal carries the treasurer's seed and nothing else: the
 * member nonces are the ones members released and the database stored. A body
 * that supplies `memberNonces` is refused (strict), so nobody can substitute an
 * opening for what was sealed.
 */
export const drawRevealRequestSchema = z
  .object({
    drawId: uuidSchema,
    seed: entropySchema,
    idempotencyKey: idempotencyKeySchema
  })
  .strict();

export const drawPayoutRequestSchema = z
  .object({
    drawId: uuidSchema,
    cashAccountId: uuidSchema,
    payoutAccountId: uuidSchema,
    occurredAt: timestampSchema.optional()
  })
  .strict()
  .superRefine((value, context) => {
    if (value.cashAccountId === value.payoutAccountId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["payoutAccountId"],
        message: "A payout must move money between two distinct accounts"
      });
    }
  });

export const drawIdSchema = uuidSchema;
export const drawCycleIdSchema = uuidSchema;

export type DrawCommitRequestInput = z.input<typeof drawCommitRequestSchema>;
export type ValidatedDrawCommitRequest = z.output<typeof drawCommitRequestSchema>;
export type DrawRevealRequestInput = z.input<typeof drawRevealRequestSchema>;
export type ValidatedDrawRevealRequest = z.output<typeof drawRevealRequestSchema>;
export type DrawPayoutRequestInput = z.input<typeof drawPayoutRequestSchema>;
export type ValidatedDrawPayoutRequest = z.output<typeof drawPayoutRequestSchema>;
