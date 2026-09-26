import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { canWriteLedger } from "@/lib/roles";
import { bearerToken, getUserScopedClient } from "@/lib/supabaseServer";
import { createProductionBankVerificationService } from "@/lib/banking/server";
import { BankVerificationError, isBankVerificationError } from "@/lib/banking/errors";
import { bankVerificationIdSchema, bankVerificationRequestSchema, parse } from "@/lib/validation";
import type { BankVerificationService } from "@/lib/banking/service";

const MAX_BODY_BYTES = 8_192;

export type BankVerificationServiceFactory = (client: SupabaseClient) => BankVerificationService;
export type BankVerificationRouteContext = {
  readonly params: { readonly verificationId: string };
};

function jsonError(error: string, status: number, message?: string): Response {
  return Response.json(
    message ? { error, message } : { error },
    { status, headers: { "Cache-Control": "no-store" } }
  );
}

function mapBankError(error: unknown): Response {
  if (!isBankVerificationError(error)) {
    return jsonError("bank_verification_failed", 502);
  }
  switch (error.code) {
    case "UNAUTHORIZED":
      return jsonError("unauthorized", 401);
    case "FORBIDDEN":
      return jsonError("forbidden", 403);
    case "NOT_FOUND":
      return jsonError("not_found", 404);
    case "IDEMPOTENCY_CONFLICT":
      return jsonError("idempotency_conflict", 409);
    case "INVALID_REQUEST":
    case "INVALID_BINDING":
      return jsonError("unprocessable_bank_verification", 422);
    case "PROVIDER_NOT_CONFIGURED":
    case "STORAGE_UNAVAILABLE":
      return jsonError("not_configured", 503);
    case "PROVIDER_UNAVAILABLE":
    case "INVALID_PROVIDER_RESULT":
    case "STORAGE_FAILURE":
    case "INTEGRITY_FAILURE":
      return jsonError("bank_verification_unavailable", 502);
  }
}

function productionFactory(client: SupabaseClient): BankVerificationService {
  return createProductionBankVerificationService(client);
}

export function createPostHandler(
  serviceFactory: BankVerificationServiceFactory = productionFactory
): (request: Request) => Promise<Response> {
  return async function post(request: Request): Promise<Response> {
    const token = bearerToken(request);
    if (!token) {
      return jsonError("unauthorized", 401);
    }
    const supabase = getUserScopedClient(token);
    if (!supabase) {
      return jsonError("not_configured", 503);
    }
    const authResult = await supabase.auth.getUser().catch(() => null);
    if (!authResult) {
      return jsonError("auth_unavailable", 503);
    }
    if (authResult.error || !authResult.data.user) {
      return jsonError("unauthorized", 401);
    }
    if (!canWriteLedger(authResult.data.user)) {
      return jsonError("forbidden", 403);
    }
    const contentType = request.headers.get("content-type")?.toLowerCase();
    if (
      !contentType ||
      (contentType !== "application/json" && !contentType.startsWith("application/json;"))
    ) {
      return jsonError("bad_request", 400);
    }
    const declaredLength = Number(request.headers.get("content-length") ?? "0");
    if (!Number.isFinite(declaredLength) || declaredLength < 0 || declaredLength > MAX_BODY_BYTES) {
      return jsonError("bad_request", 400);
    }
    let body: unknown;
    try {
      const rawBody = await request.text();
      if (new TextEncoder().encode(rawBody).byteLength > MAX_BODY_BYTES) {
        return jsonError("bad_request", 400);
      }
      body = JSON.parse(rawBody) as unknown;
    } catch {
      return jsonError("bad_request", 400);
    }
    const parsed = parse(bankVerificationRequestSchema, body);
    if (!parsed.ok) {
      return jsonError("invalid_request", 400, parsed.message);
    }
    try {
      const service = serviceFactory(supabase);
      const result = await service.create(parsed.data, { userId: authResult.data.user.id });
      const status = result.replayed ? 200 : result.verification.state === "PENDING_RECONCILIATION" ? 202 : 201;
      return Response.json(result.verification, {
        status,
        headers: { "Cache-Control": "no-store" }
      });
    } catch (error) {
      if (error instanceof BankVerificationError && error.code === "PROVIDER_NOT_CONFIGURED") {
        return jsonError("not_configured", 503);
      }
      return mapBankError(error);
    }
  };
}

export function createGetHandler(
  serviceFactory: BankVerificationServiceFactory = productionFactory
): (request: Request, context: BankVerificationRouteContext) => Promise<Response> {
  return async function get(
    request: Request,
    context: BankVerificationRouteContext
  ): Promise<Response> {
    const token = bearerToken(request);
    if (!token) {
      return jsonError("unauthorized", 401);
    }
    const supabase = getUserScopedClient(token);
    if (!supabase) {
      return jsonError("not_configured", 503);
    }
    const authResult = await supabase.auth.getUser().catch(() => null);
    if (!authResult) {
      return jsonError("auth_unavailable", 503);
    }
    if (authResult.error || !authResult.data.user) {
      return jsonError("unauthorized", 401);
    }
    const parsedId = bankVerificationIdSchema.safeParse(context.params.verificationId);
    if (!parsedId.success) {
      return jsonError("not_found", 404);
    }
    try {
      const service = serviceFactory(supabase);
      const verification = await service.get(parsedId.data, {
        userId: authResult.data.user.id
      });
      return Response.json(verification, {
        status: 200,
        headers: { "Cache-Control": "no-store" }
      });
    } catch (error) {
      if (error instanceof BankVerificationError && error.code === "PROVIDER_NOT_CONFIGURED") {
        return jsonError("not_configured", 503);
      }
      return mapBankError(error);
    }
  };
}
