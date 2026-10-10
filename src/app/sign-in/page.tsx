"use client";

import React from "react";

import { AuthCard } from "@/components/auth/AuthCard";

/** `/sign-in`: email link or 6-digit code for an existing account; never creates one. */
export default function SignInPage() {
  return <AuthCard mode="sign-in" />;
}
