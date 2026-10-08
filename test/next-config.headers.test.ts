// @vitest-environment node
import { describe, expect, it } from "vitest";

import nextConfig from "../next.config.mjs";

describe("next.config headers and build id", () => {
  it("does not mark the unhashed icons immutable, and still lets them be cached for a day", async () => {
    const rules = (await nextConfig.headers?.()) ?? [];
    const icons = rules.find((rule) => rule.source === "/icons/:path*");
    const cacheControl = icons?.headers.find((header) => header.key === "Cache-Control")?.value ?? "";
    expect(cacheControl).not.toMatch(/immutable/);
    expect(cacheControl).toMatch(/max-age=\d+/);
    expect(cacheControl).toMatch(/must-revalidate/);
  });

  it("stamps one build id into the client bundle and Next build id", async () => {
    const id = (nextConfig.env as Record<string, string>).NEXT_PUBLIC_BUILD_ID;
    expect(id).toMatch(/^[A-Za-z0-9._-]{1,12}$/);
    expect(await nextConfig.generateBuildId?.()).toBe(id);
  });
});
