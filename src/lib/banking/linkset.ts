import "server-only";
import { formatEtbAmount, isEtbAmount } from "@/lib/ledger/money";
import { BankVerificationError } from "./errors";
import { createProviderReferenceHmac } from "./vault";
import type {
  BankDirection,
  BankProvider,
  BankProviderAdapter,
  BankProviderEvidence,
  BankProviderLookup,
  BankProviderResult
} from "./types";

/**
 * links.et (by Odit) receipt verification client.
 *
 * links.et fetches a receipt from the issuing Ethiopian bank over an
 * Ethiopia-egress link and returns the bank's own record as JSON. It is a
 * *read* service: it never moves money and never needs bank credentials.
 *
 * Reference: https://links.et/docs and https://links.et/agents.md
 *
 * ## Why this adapter is asynchronous by design
 *
 * ROADMAP M2.2 asks for verification "within 800ms". links.et cannot always
 * answer that fast: an uncached receipt against a busy bank holds the
 * connection for up to ~120s (30s upstream slot wait, 20s fetch, 20s retry on
 * another egress address). Pretending otherwise would mean either lying about
 * latency or abandoning the request.
 *
 * So the 800ms budget is applied as a *first-response* budget via links.et's
 * `waitMs`: we ask it to block briefly, and when it answers `202 queued` we
 * return `unsettled`, which the service maps to `PENDING_RECONCILIATION`, and
 * the reconciliation queue picks the intent up later. This is exactly the
 * graceful-degradation path M2.3 describes, and receipts are cached forever by
 * links.et, so retries are cheap and cache hits are instant and free.
 *
 * ## Deliberate non-behaviour
 *
 * Receipt URLs are credentials: a receipt URL is a lookup key for somebody's
 * whole transaction at their bank. Nothing in this module logs a reference, a
 * resolved URL, a masked account, or a response body, and no such value is ever
 * placed in an error message that ships to a client.
 */

/** The subset of links.et receipt sources Sened accepts, per provider. */
const ACCEPTED_SOURCES: Record<BankProvider, readonly string[]> = {
  // CBE has two live shapes. `cbebirr-pdf` is deliberately excluded: CBE Birr
  // is a different product and must not satisfy a CBE binding.
  telebirr: ["telebirr-html"],
  cbe: ["cbe-pdf", "mb-json"],
  awash: ["awash-html"]
};

const DEFAULT_BASE_URL = "https://links.et";
const DEFAULT_WAIT_MS = 800;
const DEFAULT_TIMEOUT_MS = 5_000;
const MIN_TIMEOUT_MS = 2_000;
const MAX_WAIT_MS = 30_000;
const MAX_RESPONSE_BYTES = 256 * 1024;

/**
 * Ethiopia Time is UTC+3 and links.et fetches from Ethiopian hosts, so bank
 * receipt timestamps are EAT wall-clock. Receipts that carry no offset are
 * interpreted in this offset and then converted to UTC.
 */
const DEFAULT_ETB_OFFSET_MINUTES = 180;

const DEFAULT_TIMESTAMP_TOLERANCE_SECONDS = 900;

export interface LinksEtConfig {
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly waitMs: number;
  readonly timeoutMs: number;
  readonly fingerprintKey: string | Buffer;
  readonly etbOffsetMinutes: number;
  readonly timestampToleranceSeconds: number;
}

export interface LinksEtAdapterOptions {
  readonly provider: BankProvider;
  readonly config: LinksEtConfig;
  readonly fetchImpl?: typeof fetch;
  readonly timestampToleranceSeconds?: number;
}
function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new BankVerificationError("PROVIDER_NOT_CONFIGURED", `${name} is not configured`);
  }
  return value;
}

function readPositiveInt(name: string, fallback: number, max: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > max) {
    throw new BankVerificationError(
      "PROVIDER_NOT_CONFIGURED",
      `${name} must be a positive integer no greater than ${max}`
    );
  }
  return parsed;
}

/**
 * Reads links.et configuration from the environment. Fails closed: a missing
 * key or HMAC key means the adapter reports itself unconfigured rather than
 * silently degrading.
 */
export function readLinksEtConfigFromEnvironment(): LinksEtConfig {
  const apiKey = requireEnv("LINKS_ET_API_KEY");
  if (!apiKey.startsWith("vk_")) {
    throw new BankVerificationError(
      "PROVIDER_NOT_CONFIGURED",
      "LINKS_ET_API_KEY is not a links.et API key"
    );
  }
  const baseUrl = (process.env.LINKS_ET_BASE_URL?.trim() || DEFAULT_BASE_URL).replace(/\/+$/, "");
  const waitMs = readPositiveInt("LINKS_ET_WAIT_MS", DEFAULT_WAIT_MS, MAX_WAIT_MS);
  const timeoutMs = Math.max(
    readPositiveInt("LINKS_ET_TIMEOUT_MS", DEFAULT_TIMEOUT_MS, 120_000),
    waitMs + 1_000,
    MIN_TIMEOUT_MS
  );
  return {
    apiKey,
    baseUrl,
    waitMs,
    timeoutMs,
    fingerprintKey: requireEnv("BANK_REFERENCE_HMAC_KEY"),
    etbOffsetMinutes: readPositiveInt(
      "LINKS_ET_ETB_OFFSET_MINUTES",
      DEFAULT_ETB_OFFSET_MINUTES,
      840
    ),
    timestampToleranceSeconds: readPositiveInt(
      "LINKS_ET_TIMESTAMP_TOLERANCE_SECONDS",
      DEFAULT_TIMESTAMP_TOLERANCE_SECONDS,
      86_400
    )
  };
}

export function isLinksEtConfigured(): boolean {
  return Boolean(process.env.LINKS_ET_API_KEY?.trim() && process.env.BANK_REFERENCE_HMAC_KEY?.trim());
}

// ---------------------------------------------------------------------------
// Value parsing
//
// links.et rule 6: "Amount fields are numbers on some providers and strings on
// others. Never feed them straight into arithmetic."
// ---------------------------------------------------------------------------

/**
 * Parses a receipt amount into canonical ETB wire form.
 *
 * Handles `"102 Birr"` (telebirr), `"100 ETB"` (awash), `260` (CBE JSON/PDF),
 * and grouped forms like `"1,250.50"`. Returns null when the value is absent or
 * is not a strictly positive ETB amount, so the caller can treat it as an
 * incomplete receipt rather than coercing it to zero.
 */
export function parseReceiptAmount(value: unknown): string | null {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value <= 0) {
      return null;
    }
    return canonicalizeEtb(value.toFixed(2));
  }
  if (typeof value !== "string") {
    return null;
  }
  // Strip the trailing currency word ("102 Birr", "100 ETB") and grouping commas.
  const numeric = value.replace(/[A-Za-z]{3,}\s*$/u, "").replace(/,/g, "").trim();
  if (!/^\d+(?:\.\d+)?$/.test(numeric)) {
    return null;
  }
  return canonicalizeEtb(numeric);
}

function canonicalizeEtb(numeric: string): string | null {
  const [whole, fraction = ""] = numeric.split(".");
  const padded = `${whole}.${fraction.padEnd(2, "0").slice(0, 2)}`;
  return isEtbAmount(padded, true) ? formatEtbAmount(padded) : null;
}

/**
 * Derives the receipt currency. Telebirr is ETB-only and prints no currency
 * field, so its absence is not an error. CBE and Awash both print one.
 */
export function parseReceiptCurrency(explicit: unknown, amount: string | null): string | null {
  if (typeof explicit === "string" && /^[A-Za-z]{3}$/.test(explicit.trim())) {
    return explicit.trim().toUpperCase();
  }
  if (amount && /\bETB\b/.test(amount)) {
    return "ETB";
  }
  return null;
}

/**
 * Normalizes a masked account number exactly as the bank prints it.
 *
 * ## Security note — this is a weak signal, and it is inherent to the data
 *
 * Every provider masks account numbers on the public receipt
 * (`251********`, `1****0000`, `XXXXX******XXXX/BANK`). Sened therefore *cannot*
 * compare a full account number; the strongest value available on both sides is
 * the masked form. These masks are low entropy and are shared by many accounts,
 * so a sender/receiver match is corroboration, never proof.
 *
 * The load-bearing signals in a Sened verification are that links.et fetched the
 * record from the issuing bank using a reference the treasurer supplied, and
 * that the bank's own amount, currency and timestamp agree with the declared
 * contribution. Account masks only narrow that. Bindings must be registered
 * using the masked form exactly as the bank prints it, including mask width.
 */
export function normalizeMaskedAccount(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  // Awash appends a branch suffix, e.g. "XXXXX******XXXX/BANK".
  const withoutBranch = value.split("/")[0] ?? "";
  const normalized = withoutBranch.replace(/\s+/g, "").toUpperCase();
  return normalized.length > 0 ? normalized : null;
}

/**
 * Produces the fingerprint used to compare a receipt account against a binding.
 *
 * Uses a dedicated domain separator so a masked-account fingerprint can never
 * collide with a provider-reference fingerprint, which is hashed by
 * `createProviderReferenceHmac`.
 */
export function createMaskedAccountFingerprint(
  provider: BankProvider,
  maskedAccount: string,
  key: string | Buffer
): string {
  return createProviderReferenceHmac(provider, `masked-account:${maskedAccount}`, key);
}

type TimestampOrder = "day-first" | "month-first" | "year-first";

function applyEtbOffset(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  offsetMinutes: number
): string | null {
  const utcMillis =
    Date.UTC(year, month - 1, day, hour, minute, second) - offsetMinutes * 60_000;
  const date = new Date(utcMillis);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  return date.toISOString();
}

/**
 * Parses a receipt timestamp into a UTC ISO string.
 *
 * Bank timestamps are wall-clock with no offset, so they are interpreted in the
 * configured EAT offset. Formats differ per source:
 * - `telebirr-html`  `01-01-2026 00:00:00`   day-first (Ethiopian bank form)
 * - `cbe-pdf`        `1/1/2026, 00:00:00 AM`  month-first, 12-hour clock
 * - `mb-json`        `2026-01-01T00:00:00Z`   already offset-aware
 * - `awash-html`     `2026-01-01 00:00:00 AM` ISO-like date, 12-hour clock
 *
 * The day-first/month-first choice is a documented assumption per source and the
 * one genuinely ambiguous field in the feeds; operators should confirm it once
 * against a receipt they control. A wrong guess shifts the instant by at most a
 * month, which the timestamp tolerance absorbs only if the treasurer's declared
 * time is close, so it is called out rather than hidden.
 */
export function parseReceiptTimestamp(
  value: unknown,
  source: string,
  etbOffsetMinutes: number
): string | null {
  if (typeof value !== "string" || value.trim().length === 0) {
    return null;
  }
  const raw = value.trim();

  const iso = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})$/.test(raw);
  if (iso) {
    const parsed = new Date(raw);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
  }

  const meridiem = /\b(AM|PM)\b/i.exec(raw);
  let working = raw.replace(/,/, " ").replace(/\b(AM|PM)\b/gi, " ").trim();

  const parts = working.split(/[\s/:.-]+/).filter(Boolean);
  if (parts.length < 3) {
    return null;
  }

  let hour = Number.parseInt(parts[parts.length - 3] ?? "", 10);
  const minute = Number.parseInt(parts[parts.length - 2] ?? "", 10);
  const second = parts.length >= 4 ? Number.parseInt(parts[parts.length - 1] ?? "", 10) : 0;
  if (!Number.isInteger(hour) || !Number.isInteger(minute) || !Number.isInteger(second)) {
    return null;
  }
  if (meridiem) {
    const isPm = /pm/i.test(meridiem[0]);
    if (hour === 12) {
      hour = 0;
    }
    if (isPm) {
      hour += 12;
    }
  }

  const order: TimestampOrder =
    source === "cbe-pdf" ? "month-first" : source === "awash-html" ? "year-first" : "day-first";
  const first = Number.parseInt(parts[0] ?? "", 10);
  const secondPart = Number.parseInt(parts[1] ?? "", 10);
  const yearToken = parts[2] ?? "";

  let day: number;
  let month: number;
  let year: number;
  if (order === "year-first") {
    year = first;
    month = secondPart;
    day = Number.parseInt(yearToken, 10);
  } else if (order === "month-first") {
    month = first;
    day = secondPart;
    year = Number.parseInt(yearToken, 10);
  } else {
    day = first;
    month = secondPart;
    year = Number.parseInt(yearToken, 10);
  }

  if (year < 100) {
    year += year >= 70 ? 1900 : 2000;
  }
  if (!Number.isInteger(day) || !Number.isInteger(month) || !Number.isInteger(year)) {
    return null;
  }
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) {
    return null;
  }

  return applyEtbOffset(year, month, day, hour, minute, second, etbOffsetMinutes);
}

// ---------------------------------------------------------------------------
// Receipt normalizers
// ---------------------------------------------------------------------------

interface NormalizedReceipt {
  readonly providerTransactionId: string;
  readonly amount: string;
  readonly currency: string;
  readonly senderMaskedAccount: string | null;
  readonly receiverMaskedAccount: string | null;
  readonly occurredAt: string | null;
  readonly settled: boolean;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeTelebirr(
  receipt: Record<string, unknown>,
  etbOffsetMinutes: number
): NormalizedReceipt | null {
  const receiptNo = readString(receipt, "receiptNo");
  if (!receiptNo) {
    return null;
  }
  // `settledAmount` is what the payer actually sent to the recipient.
  // `totalPaidAmount` additionally includes serviceFee + VAT, so matching
  // against it would reject every real contribution by the fee amount.
  const amount = parseReceiptAmount(receipt.settledAmount) ?? parseReceiptAmount(receipt.totalPaidAmount);
  if (!amount) {
    return null;
  }
  const status = readString(receipt, "transactionStatus");
  return {
    providerTransactionId: receiptNo,
    amount,
    currency: parseReceiptCurrency(receipt.currency, readString(receipt, "settledAmount")) ?? "ETB",
    senderMaskedAccount: normalizeMaskedAccount(receipt.payerTelebirrNo),
    receiverMaskedAccount: normalizeMaskedAccount(receipt.creditedPartyAccountNo),
    occurredAt: parseReceiptTimestamp(receipt.paymentDate, "telebirr-html", etbOffsetMinutes),
    settled: status === null || status.toLowerCase() === "completed"
  };
}

function normalizeCbe(
  receipt: Record<string, unknown>,
  source: string,
  etbOffsetMinutes: number
): NormalizedReceipt | null {
  const reference = readString(receipt, "reference");
  if (!reference) {
    return null;
  }
  const amount = parseReceiptAmount(receipt.transferredAmount) ?? parseReceiptAmount(receipt.totalAmount);
  if (!amount) {
    return null;
  }
  return {
    providerTransactionId: reference,
    amount,
    currency: parseReceiptCurrency(receipt.currency, null) ?? "ETB",
    senderMaskedAccount: normalizeMaskedAccount(receipt.payerAccount),
    receiverMaskedAccount: normalizeMaskedAccount(receipt.receiverAccount),
    occurredAt: parseReceiptTimestamp(receipt.paymentDate, source, etbOffsetMinutes),
    // cbe-pdf and mb-json carry no status field; a receipt that parsed with a
    // reference and an amount is the bank's record of a completed transfer.
    settled: true
  };
}

function normalizeAwash(
  receipt: Record<string, unknown>,
  etbOffsetMinutes: number
): NormalizedReceipt | null {
  const customer = asRecord(receipt.customer);
  const transaction = asRecord(receipt.transaction);
  if (!transaction) {
    return null;
  }
  const transactionId = readString(transaction, "transactionId");
  if (!transactionId) {
    return null;
  }
  const rawAmount = readString(transaction, "amount");
  const amount = parseReceiptAmount(rawAmount);
  if (!amount) {
    return null;
  }
  return {
    providerTransactionId: transactionId,
    amount,
    currency: parseReceiptCurrency(null, rawAmount) ?? "ETB",
    senderMaskedAccount: normalizeMaskedAccount(transaction.senderAccount),
    receiverMaskedAccount:
      normalizeMaskedAccount(transaction.beneficiaryAccount) ??
      normalizeMaskedAccount(customer?.accountNo),
    occurredAt: parseReceiptTimestamp(transaction.transactionTime, "awash-html", etbOffsetMinutes),
    settled: true
  };
}

function normalizeReceipt(
  provider: BankProvider,
  receipt: Record<string, unknown>,
  source: string,
  etbOffsetMinutes: number
): NormalizedReceipt | null {
  switch (source) {
    case "telebirr-html":
      return normalizeTelebirr(receipt, etbOffsetMinutes);
    case "cbe-pdf":
    case "mb-json":
      return normalizeCbe(receipt, source, etbOffsetMinutes);
    case "awash-html":
      return normalizeAwash(receipt, etbOffsetMinutes);
    default:
      // Unknown source for a known provider: refuse rather than guess a shape.
      void provider;
      return null;
  }
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

function parseRetryAfter(header: string | null): number | undefined {
  if (!header) {
    return undefined;
  }
  const seconds = Number.parseInt(header.trim(), 10);
  if (Number.isInteger(seconds) && seconds >= 0 && seconds <= 86_400) {
    return seconds;
  }
  const date = new Date(header);
  if (!Number.isNaN(date.getTime())) {
    return Math.max(0, Math.round((date.getTime() - Date.now()) / 1_000));
  }
  return undefined;
}

/**
 * Production links.et adapter.
 *
 * Implements the real wire contract, fails closed when unconfigured, and
 * translates every documented links.et failure mode into one of Sened's
 * pending kinds so the reconciliation queue can act on it.
 */
export class LinksEtBankProviderAdapter implements BankProviderAdapter {
  readonly provider: BankProvider;
  private readonly config: LinksEtConfig;
  private readonly fetchImpl: typeof fetch;
  readonly timestampToleranceSeconds: number;

  constructor(options: LinksEtAdapterOptions) {
    this.provider = options.provider;
    this.config = options.config;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timestampToleranceSeconds =
      options.timestampToleranceSeconds ??
      options.config.timestampToleranceSeconds ??
      DEFAULT_TIMESTAMP_TOLERANCE_SECONDS;
  }

  isConfigured(): boolean {
    return true;
  }

  async verify(lookup: BankProviderLookup): Promise<BankProviderResult> {
    if (lookup.provider !== this.provider) {
      throw new BankVerificationError(
        "INVALID_REQUEST",
        "Bank provider lookup does not match the adapter"
      );
    }
    return this.requestReceipt(lookup, this.config.waitMs);
  }

  private async requestReceipt(
    lookup: BankProviderLookup,
    waitMs: number
  ): Promise<BankProviderResult> {
    const url = new URL("/api/verify", this.config.baseUrl);
    // Telebirr accepts a bare reference; every other provider needs a full URL.
    const body: Record<string, unknown> =
      this.provider === "telebirr"
        ? { reference: lookup.transactionReference }
        : { url: lookup.transactionReference };
    body.waitMs = waitMs;

    // The same key replays the first response, which makes a reconciliation
    // retry safe and free.
    const idempotencyKey = createProviderReferenceHmac(
      this.provider,
      lookup.transactionReference,
      this.config.fingerprintKey
    );

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);

    let response: Response;
    try {
      response = await this.fetchImpl(url.toString(), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          "x-api-key": this.config.apiKey,
          "Idempotency-Key": idempotencyKey
        },
        body: JSON.stringify(body),
        signal: controller.signal,
        cache: "no-store"
      });
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        return { provider: this.provider, kind: "timeout" };
      }
      return { provider: this.provider, kind: "provider_error" };
    } finally {
      clearTimeout(timer);
    }

    if (response.status === 202) {
      // Queued for an asynchronous fetch; the reconciliation queue resumes it.
      return { provider: this.provider, kind: "unsettled" };
    }

    const declaredLength = Number.parseInt(response.headers.get("content-length") ?? "", 10);
    if (Number.isInteger(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
      return { provider: this.provider, kind: "invalid_response" };
    }

    let payload: unknown;
    try {
      const text = await response.text();
      if (text.length > MAX_RESPONSE_BYTES) {
        return { provider: this.provider, kind: "invalid_response" };
      }
      payload = JSON.parse(text);
    } catch {
      return { provider: this.provider, kind: "invalid_response" };
    }

    if (!response.ok) {
      return this.mapErrorStatus(response, payload);
    }
    return this.mapSuccess(payload, lookup.accountFingerprintHmac);
  }

  private mapErrorStatus(response: Response, payload: unknown): BankProviderResult {
    const envelope = asRecord(payload);
    const error = asRecord(envelope?.error);
    const code = typeof error?.code === "string" ? error.code : null;

    switch (response.status) {
      case 400:
        // `invalid_json` / `invalid_request` mean our request is malformed;
        // a bare 400 means links.et never got an upstream status (bad URL, or
        // it gave up waiting for a busy bank). Both are worth retrying, and the
        // attempt ceiling escalates a persistent failure to MANUAL_REVIEW.
        return { provider: this.provider, kind: code ? "provider_error" : "unsettled" };
      case 401:
        // missing_key / invalid_key / revoked_key are not retryable: the
        // deployment is misconfigured. Fail closed loudly rather than looping.
        throw new BankVerificationError(
          "PROVIDER_NOT_CONFIGURED",
          "links.et rejected the configured API key"
        );
      case 429:
        if (code === "rate_limited") {
          const retryAfterSeconds = parseRetryAfter(response.headers.get("retry-after"));
          return {
            provider: this.provider,
            kind: "rate_limited",
            retryAfterSeconds: retryAfterSeconds ?? 1
          };
        }
        // `quota_exceeded` and the image/OCR caps have no useful short timer —
        // a quota can be days out. Map to a generic retry so the attempt
        // ceiling sends it to MANUAL_REVIEW instead of hammering all month.
        return { provider: this.provider, kind: "provider_error" };
      case 502:
        // Bank answered but the receipt failed validation. Retry with backoff.
        return { provider: this.provider, kind: "provider_error" };
      case 503:
        // provider_down: honour Retry-After as documented.
        return {
          provider: this.provider,
          kind: "rate_limited",
          retryAfterSeconds: parseRetryAfter(response.headers.get("retry-after")) ?? 300
        };
      default:
        return { provider: this.provider, kind: "provider_error" };
    }
  }

  private mapSuccess(
    payload: unknown,
    treasuryAccountFingerprint: string | null
  ): BankProviderResult {
    const envelope = asRecord(payload);
    if (!envelope || envelope.ok !== true) {
      return { provider: this.provider, kind: "invalid_response" };
    }
    if (readString(envelope, "providerKey") !== this.provider) {
      return { provider: this.provider, kind: "invalid_response" };
    }

    // links.et rule 1: switch on `receipt.source`, never on the host.
    const receipt = asRecord(envelope.receipt);
    const source = receipt ? readString(receipt, "source") : null;
    if (!receipt || !source) {
      return { provider: this.provider, kind: "invalid_response" };
    }
    if (!ACCEPTED_SOURCES[this.provider].includes(source)) {
      return { provider: this.provider, kind: "invalid_response" };
    }

    const normalized = normalizeReceipt(
      this.provider,
      receipt,
      source,
      this.config.etbOffsetMinutes
    );
    if (!normalized) {
      return { provider: this.provider, kind: "invalid_response" };
    }
    if (!normalized.settled) {
      return { provider: this.provider, kind: "unsettled" };
    }
    if (!normalized.occurredAt) {
      return { provider: this.provider, kind: "invalid_response" };
    }

    const evidence = this.toEvidence(normalized, treasuryAccountFingerprint);
    if (!evidence) {
      return { provider: this.provider, kind: "invalid_response" };
    }
    return { provider: this.provider, kind: "settled", evidence };
  }

  private toEvidence(
    normalized: NormalizedReceipt,
    treasuryAccountFingerprint: string | null
  ): BankProviderEvidence | null {
    const senderFingerprint = normalized.senderMaskedAccount
      ? createMaskedAccountFingerprint(
          this.provider,
          normalized.senderMaskedAccount,
          this.config.fingerprintKey
        )
      : null;
    const receiverFingerprint = normalized.receiverMaskedAccount
      ? createMaskedAccountFingerprint(
          this.provider,
          normalized.receiverMaskedAccount,
          this.config.fingerprintKey
        )
      : null;
    if (!senderFingerprint || !receiverFingerprint || !normalized.occurredAt) {
      return null;
    }

    // The provider publishes no direction relative to the treasury, so it is
    // inferred from which side of the receipt is our own account. If neither
    // side matches, the fingerprint comparison in matching.ts rejects it, so a
    // wrong inference here can never admit a false match.
    const direction: BankDirection =
      treasuryAccountFingerprint && receiverFingerprint === treasuryAccountFingerprint
        ? "inbound"
        : "outbound";

    return {
      providerTransactionId: normalized.providerTransactionId,
      amount: normalized.amount,
      currency: normalized.currency,
      direction,
      senderFingerprint,
      receiverFingerprint,
      occurredAt: normalized.occurredAt,
      settledAt: normalized.occurredAt
    };
  }
}
