import { createGateSetHandler } from "@/lib/draw/routeHandlers";

export const runtime = "nodejs";
/** `POST` changes a cycle's contribution gate (owner or treasurer), with a recorded reason. */
export const POST = createGateSetHandler();
