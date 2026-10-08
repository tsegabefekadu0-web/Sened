import { createCycleReadHandler } from "@/lib/draw/routeHandlers";

export const runtime = "nodejs";
export const GET = createCycleReadHandler();
