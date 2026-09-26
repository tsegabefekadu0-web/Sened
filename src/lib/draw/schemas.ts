import { z } from "zod";

import { WIRE_ETB_DECIMAL_PATTERN } from "@/lib/ledger/money";
import {
  DRAW_MEMBER_STATUSES,
  DRAW_ROUND_STATES,
  DRAW_VERIFICATION_CODES
} from "./types";

const uuidSchema = z.string().uuid().transform((value) => value.toLowerCase());

const amountSchema = z
  .string()
  .max(21)
  .regex(WIRE_ETB_DECIMAL_PATTERN, "Invalid ETB amount")
  .refine((value) => !/^0\.00$/.test(value), "Amount must be positive");

const hex64Schema = z
  .string()
  .regex(/^[0-9a-f]{64}$/, "Expected a 64-character lowercase SHA-256 digest")
  .transform((value) => value.toLowerCase());

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
export const drawMemberStatusSchema = z.enum(DRAW_MEMBER_STATUSES);
export const drawVerificationCodeSchema = z.enum(DRAW_VERIFICATION_CODES);

export const drawMemberSchema = z
  .object({
    memberId: uuidSchema,
    displayName: z.string().trim().min(1).max(120),
    status: drawMemberStatusSchema.default("active"),
    contributionAmount: amountSchema
  })
  .strict();

export const drawParticipantSchema = z
  .object({
    memberId: uuidSchema,
    displayName: z.string().trim().min(1).max(120),
    contributionAmount: amountSchema,
    ticket: hex64Schema
  })
  .strict();

/**
 * M4.1 step 1. The client may supply `seed` and `commitmentNonce` — an offline
 * treasurer generates them on-device so the values never touch our servers
 * before the ceremony. Both are optional; the server fills them from a CSPRNG
 * when absent, and refuses anything under 16 characters either way.
 */
export const drawCommitRequestSchema = z
  .object({
    groupId: uuidSchema,
    cycleId: uuidSchema,
    round: z.number().int().min(1).max(1_000),
    totalRounds: z.number().int().min(1).max(1_000),
    drawId: uuidSchema.optional(),
    commitmentNonce: entropySchema.optional(),
    seed: entropySchema.optional(),
    potAmount: amountSchema,
    reserveRatioBps: z.number().int().min(0).max(3_333),
    members: z.array(drawMemberSchema).min(1).max(2_000),
    idempotencyKey: idempotencyKeySchema,
    committedAt: timestampSchema.optional()
  })
  .strict()
  .superRefine((value, context) => {
    if (value.round > value.totalRounds) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["round"],
        message: "Round must fall within the cycle's total rounds"
      });
    }
    if (value.commitmentNonce !== undefined && value.commitmentNonce === value.seed) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["commitmentNonce"],
        message: "The commitment nonce must differ from the seed"
      });
    }
    const memberIds = new Set<string>();
    for (const [index, member] of value.members.entries()) {
      if (memberIds.has(member.memberId)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["members", index, "memberId"],
          message: "Duplicate member in the roster"
        });
      }
      memberIds.add(member.memberId);
    }
  });

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
