import type { Metadata } from "next";

import { SignInPanel } from "@/components/auth/SignInPanel";

export const metadata: Metadata = {
  title: "Sened | Sign in",
  description: "Sign in to send contributions to the bank for verification."
};

/**
 * `GET /sign-in` — the client sign-in surface (AGENTWORK.md O-1, blocker 1).
 * It is what lets a browser hold the Supabase JWT every Bearer-auth route needs.
 */
export default function SignInPage() {
  return <SignInPanel />;
}
