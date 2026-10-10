import { afterEach, describe, expect, it, vi } from "vitest";

import { isEmailRateLimitError } from "@/lib/auth/rateLimit";
import { avatarPath, photoToDataUrl } from "@/lib/ui/profile";

describe("isEmailRateLimitError", () => {
  it("detects a 429 status, the rate-limit codes and the message", () => {
    expect(isEmailRateLimitError({ status: 429 })).toBe(true);
    expect(isEmailRateLimitError({ code: "over_email_send_rate_limit" })).toBe(true);
    expect(isEmailRateLimitError({ message: "email rate limit exceeded" })).toBe(true);
  });
  it("ignores other errors", () => {
    expect(isEmailRateLimitError({ status: 400, message: "invalid" })).toBe(false);
    expect(isEmailRateLimitError(null)).toBe(false);
  });
});

describe("avatar compression", () => {
  afterEach(() => vi.unstubAllGlobals());

  function stub(webpWorks: boolean, width = 1000, height = 600) {
    const drawImage = vi.fn();
    const canvas = {
      width: 0,
      height: 0,
      getContext: () => ({ drawImage }),
      toDataURL: (type: string) => (type === "image/webp" && !webpWorks ? "data:image/png;base64,x" : `data:${type};base64,x`)
    };
    vi.spyOn(document, "createElement").mockReturnValue(canvas as unknown as HTMLElement);
    vi.stubGlobal("createImageBitmap", vi.fn().mockResolvedValue({ width, height, close: vi.fn() }));
    return { canvas, drawImage };
  }
  const file = (type = "image/png") => new File(["a"], "a.png", { type });

  it("crops to a square no larger than 256px and encodes WebP", async () => {
    const { canvas, drawImage } = stub(true);
    expect(await photoToDataUrl(file())).toBe("data:image/webp;base64,x");
    expect(canvas.width).toBe(256);
    expect(drawImage).toHaveBeenCalledWith(expect.anything(), 200, 0, 600, 600, 0, 0, 256, 256);
  });
  it("does not upscale small images", async () => {
    const { canvas } = stub(true, 100, 120);
    await photoToDataUrl(file());
    expect(canvas.width).toBe(100);
  });
  it("falls back to JPEG when WebP is unsupported", async () => {
    stub(false);
    expect(await photoToDataUrl(file())).toBe("data:image/jpeg;base64,x");
  });
  it("rejects non-images", async () => {
    expect(await photoToDataUrl(file("text/plain"))).toBeNull();
  });
  it("keeps one fixed path per member", () => {
    expect(avatarPath("u1", "image/webp")).toBe("u1/avatar.webp");
    expect(avatarPath("u1", "image/jpeg")).toBe("u1/avatar.jpg");
  });
});
