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
