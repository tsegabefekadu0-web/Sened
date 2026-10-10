/**
 * Name and phone typed on /sign-up, kept on this device until the first sign-in
 * finishes, so the profile can be filled in if the auth trigger left it empty.
 */
const KEY = "sened.signup.details";

export interface SignUpDetails {
  readonly name: string;
  readonly phone: string;
}

export function stashSignUpDetails(details: SignUpDetails): void {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(details));
  } catch {
    // Storage blocked: the account trigger still has the metadata.
  }
}

export function readSignUpDetails(): SignUpDetails | null {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return null;
    const p = JSON.parse(raw) as Partial<SignUpDetails>;
    const name = typeof p.name === "string" ? p.name.trim() : "";
    return name ? { name, phone: typeof p.phone === "string" ? p.phone : "" } : null;
  } catch {
    return null;
  }
}

export function clearSignUpDetails(): void {
  try {
    window.localStorage.removeItem(KEY);
  } catch {
    // Nothing to do.
  }
}

/** Phone as the profile keeps it (same as account/edit): local digits, the +251 prefix is only shown. */
export function formatPhone(raw: string): string {
  return raw.replace(/\D/g, "").replace(/^251/, "").replace(/^0/, "");
}
