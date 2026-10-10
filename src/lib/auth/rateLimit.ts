/** Seconds the send button stays locked after a sign-in email request. */
export const RESEND_COOLDOWN_SECONDS = 60;

/** True when Supabase Auth refused because too many emails were sent (HTTP 429). */
export function isEmailRateLimitError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const e = error as { status?: unknown; code?: unknown; message?: unknown };
  if (e.status === 429) return true;
  if (e.code === "over_email_send_rate_limit" || e.code === "over_request_rate_limit") return true;
  return typeof e.message === "string" && /rate limit/i.test(e.message);
}
