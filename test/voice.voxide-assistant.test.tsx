import { render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => {
  const instances: Array<{
    config: Record<string, unknown>;
    actions: Record<string, { dangerous?: boolean; params?: Record<string, unknown> }>;
    destroyed: boolean;
  }> = [];
  return { instances };
});

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
  usePathname: () => "/"
}));

vi.mock("@voxide/react", () => {
  class VoxideClient {
    record = { config: {} as Record<string, unknown>, actions: {} as Record<string, never>, destroyed: false };
    constructor(config: Record<string, unknown>) {
      this.record.config = config;
      hoisted.instances.push(this.record);
    }
    register(actions: Record<string, never>) {
      Object.assign(this.record.actions, actions);
      return this;
    }
    bindState() {
      return this;
    }
    onConfirmation() {
      return this;
    }
    configureUI() {
      return this;
    }
    destroy() {
      this.record.destroyed = true;
    }
  }
  return { VoxideClient, VoxideWidget: () => <div data-testid="voxide-widget" /> };
});

import { VoxideAssistant, toVoxideAction } from "@/components/assistant/VoxideAssistant";
import { createCapabilities } from "@/lib/voice/capabilities";

beforeEach(() => {
  hoisted.instances.length = 0;
  vi.unstubAllEnvs();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("VoxideAssistant", () => {
  it("renders nothing, and builds no client, without a key", () => {
    vi.stubEnv("NEXT_PUBLIC_VOXIDE_KEY", "");
    const { container } = render(<VoxideAssistant />);
    expect(container).toBeEmptyDOMElement();
    expect(hoisted.instances).toHaveLength(0);
  });

  it("treats a blank key as no key", () => {
    const { container } = render(<VoxideAssistant publicKey="   " />);
    expect(container).toBeEmptyDOMElement();
    expect(hoisted.instances).toHaveLength(0);
  });

  it("registers every capability once with the publishable key and mounts the widget", async () => {
    const { findByTestId, unmount } = render(<VoxideAssistant publicKey="vox_pub_test" />);
    await findByTestId("voxide-widget");
    expect(hoisted.instances).toHaveLength(1);
    const [client] = hoisted.instances;
    expect(client?.config.publicKey).toBe("vox_pub_test");
    expect(Object.keys(client?.actions ?? {}).sort()).toEqual(
      [
        "draftContribution",
        "getContributionStatus",
        "listPendingItems",
        "navigateTo",
        "readAudioDigest",
        "switchLanguage",
        "whoIsNextInDraw"
      ].sort()
    );
    const dangerous = Object.entries(client?.actions ?? {})
      .filter(([, action]) => action.dangerous)
      .map(([name]) => name);
    expect(dangerous).toEqual(["draftContribution"]);
    unmount();
    expect(client?.destroyed).toBe(true);
  });

  it("maps capability parameters to the Voxide shape, keeping sensitive and enum", () => {
    const capabilities = createCapabilities({
      getActiveGroupId: () => null,
      getRoute: () => "/",
      getLocale: () => "en",
      setLocale: () => {},
      navigate: () => {}
    });
    const draft = capabilities.find((capability) => capability.name === "draftContribution");
    const nav = capabilities.find((capability) => capability.name === "navigateTo");
    expect(toVoxideAction(draft!).params?.utterance).toMatchObject({ type: "string", required: true, sensitive: true });
    expect(toVoxideAction(nav!).params?.screen?.enum).toContain("ledger");
    expect(toVoxideAction(draft!).dangerous).toBe(true);
  });
});
