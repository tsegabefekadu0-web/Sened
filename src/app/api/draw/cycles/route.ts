import { createCycleCreateHandler, createCycleListHandler } from "@/lib/draw/routeHandlers";

export const runtime = "nodejs";
/** `GET ?groupId=` lists the group's cycles (any member); `POST` creates one (owner or treasurer). */
export const GET = createCycleListHandler();
export const POST = createCycleCreateHandler();
