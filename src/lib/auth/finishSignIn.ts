import { authedFetch } from "@/lib/auth/authedFetch";
import { clearSignUpDetails, readSignUpDetails } from "@/lib/auth/signUpDetails";
import { peekPendingInvite } from "@/lib/ledger/clientInvites";
import { readProfile, syncProfileToServer, writeProfile } from "@/lib/ui/profile";

/** Where a person goes once signed in: the invite they came for, else the app. */
export function postSignInPath(): string {
  return peekPendingInvite() ? "/join" : "/home";
}

/**
 * After the first sign-in from /sign-up: if the profile name is still empty,
 * save the name and phone typed on the form. Never throws; the details stay
 * on the device for the next try when the server cannot be reached.
 */
export async function completeProfileFromSignUp(): Promise<void> {
  const details = readSignUpDetails();
  if (!details) return;
  try {
    const res = await authedFetch("/api/profile", { method: "GET" });
    if (!res.ok) return;
    const data = (await res.json().catch(() => null)) as { profile?: { name?: string } } | null;
    if (data?.profile?.name?.trim()) {
      clearSignUpDetails();
      return;
    }
    const current = readProfile();
    const next = { ...current, name: details.name, phone: details.phone || current.phone };
    writeProfile(next);
    if (await syncProfileToServer(next)) clearSignUpDetails();
  } catch {
    // Keep the details; the next sign-in tries again.
  }
}
