"use client";

import React from "react";

import { HomeScreen } from "@/components/home/HomeScreen";
import { LandingPage } from "@/components/landing/LandingPage";
import { useSession } from "@/lib/auth/useSession";

/**
 * `/`: signed-in members see the app Home, everyone else sees the landing page.
 * The session is read in the browser (Supabase keeps it in local storage, which
 * is also what makes the app work offline), so the decision is made after
 * hydration. While it resolves the landing markup is rendered but kept hidden:
 * crawlers still get the page, and a signed-in member never sees it flash.
 */
export default function RootPage() {
  const session = useSession();
  if (session.status === "signed-in") return <HomeScreen />;
  if (session.status === "loading") {
    return (
      <div style={{ visibility: "hidden" }} aria-hidden="true">
        <LandingPage />
      </div>
    );
  }
  return <LandingPage />;
}
