import { createDrainHandler } from "@/lib/banking/reconciliationDrainRoute";

export const runtime = "nodejs";
// A drain is a side effect against live state; never cache or prerender it.
export const dynamic = "force-dynamic";
export const POST = createDrainHandler();
