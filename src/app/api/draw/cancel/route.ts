import { createCancelHandler } from "@/lib/draw/routeHandlers";

export const runtime = "nodejs";
/** `POST` cancels a draw whose members did not respond (owner or treasurer), with a recorded reason. */
export const POST = createCancelHandler();
