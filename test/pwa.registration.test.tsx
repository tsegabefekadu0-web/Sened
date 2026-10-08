import { render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  canRegisterServiceWorker,
  ServiceWorkerRegistration
} from "@/components/pwa/ServiceWorkerRegistration";

const originalSecure = Object.getOwnPropertyDescriptor(window, "isSecureContext");
const hadServiceWorker = "serviceWorker" in navigator;

function setSecure(value: boolean) {
  Object.defineProperty(window, "isSecureContext", { value, configurable: true });
}

function installServiceWorker(register: ReturnType<typeof vi.fn>) {
  Object.defineProperty(navigator, "serviceWorker", { value: { register }, configurable: true });
}

describe("ServiceWorkerRegistration", () => {
  let register: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    register = vi.fn().mockResolvedValue({});
    installServiceWorker(register);
    setSecure(true);
    vi.stubEnv("NODE_ENV", "production");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    if (originalSecure) {
      Object.defineProperty(window, "isSecureContext", originalSecure);
    } else {
      delete (window as unknown as Record<string, unknown>).isSecureContext;
    }
    if (!hadServiceWorker) {
      delete (navigator as unknown as Record<string, unknown>).serviceWorker;
    }
  });

  it("registers /sw.js with scope / in a production secure context", () => {
    render(<ServiceWorkerRegistration />);
    expect(register).toHaveBeenCalledTimes(1);
    expect(register).toHaveBeenCalledWith("/sw.js", { scope: "/" });
  });

  it("renders nothing", () => {
    const { container } = render(<ServiceWorkerRegistration />);
    expect(container).toBeEmptyDOMElement();
  });

  it("does not register outside production", () => {
    vi.stubEnv("NODE_ENV", "development");
    render(<ServiceWorkerRegistration />);
    expect(register).not.toHaveBeenCalled();
    vi.stubEnv("NODE_ENV", "test");
    expect(canRegisterServiceWorker()).toBe(false);
  });

  it("does not register in an insecure context", () => {
    setSecure(false);
    render(<ServiceWorkerRegistration />);
    expect(register).not.toHaveBeenCalled();
  });

  it("does not register, or throw, when serviceWorker is unsupported", () => {
    delete (navigator as unknown as Record<string, unknown>).serviceWorker;
    expect("serviceWorker" in navigator).toBe(false);
    expect(() => render(<ServiceWorkerRegistration />)).not.toThrow();
  });

  it("logs a registration failure and does not throw", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    register.mockRejectedValue(new Error("boom"));
    render(<ServiceWorkerRegistration />);
    await vi.waitFor(() => expect(warn).toHaveBeenCalledTimes(1));
  });
});

describe("ServiceWorkerRegistration build id", () => {
  it("registers a distinct script URL per build, so a deploy installs a fresh worker", async () => {
    const { serviceWorkerUrl } = await import("@/components/pwa/ServiceWorkerRegistration");
    vi.stubEnv("NEXT_PUBLIC_BUILD_ID", "k3j2h1");
    expect(serviceWorkerUrl()).toBe("/sw.js?v=k3j2h1");
    vi.stubEnv("NEXT_PUBLIC_BUILD_ID", "bad id/../");
    expect(serviceWorkerUrl()).toBe("/sw.js");
    vi.stubEnv("NEXT_PUBLIC_BUILD_ID", "");
    expect(serviceWorkerUrl()).toBe("/sw.js");
    vi.unstubAllEnvs();
  });
});
