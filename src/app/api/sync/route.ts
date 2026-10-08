import { postSync } from "@/lib/sync/routeHandlers";

export const runtime = "nodejs";

export async function POST(request: Request): Promise<Response> {
  return postSync(request);
}
