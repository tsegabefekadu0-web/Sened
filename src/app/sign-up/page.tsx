"use client";

import React from "react";

import { AuthCard } from "@/components/auth/AuthCard";

/** `/sign-up`: name, email and optional phone; creates the account and sends a link and code. */
export default function SignUpPage() {
  return <AuthCard mode="sign-up" />;
}
