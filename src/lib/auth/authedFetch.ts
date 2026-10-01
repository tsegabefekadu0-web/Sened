import { getAccessToken } from "./browserClient";

export class NotSignedInError extends Error {
  constructor() {
    super("not-signed-in");
    this.name = "NotSignedInError";
  }
}

export interface AuthedFetchDeps {
  readonly getToken?: () => Promise<string | null>;
  readonly fetchImpl?: typeof fetch;
}

/**
 * `fetch` with `Authorization: Bearer <access token>`.
 *
 * Fails closed: with no token it throws {@link NotSignedInError} and sends
 * nothing, so a signed-out caller can never produce an unauthenticated request
 * that looks like a real attempt. A caller-supplied Authorization header is
 * overwritten, never merged. A string body gets a JSON content type unless the
 * caller set one, which is what both Bearer POST routes require.
 */
export async function authedFetch(
  input: string,
  init: RequestInit = {},
  deps: AuthedFetchDeps = {}
): Promise<Response> {
  const token = await (deps.getToken ?? getAccessToken)();
  if (!token) {
    throw new NotSignedInError();
  }
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${token}`);
  if (typeof init.body === "string" && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  return (deps.fetchImpl ?? fetch)(input, { ...init, headers, cache: "no-store" });
}
