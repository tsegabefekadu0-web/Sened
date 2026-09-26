import "server-only";
import { BankVerificationError } from "./errors";
import { isLinksEtConfigured, LinksEtBankProviderAdapter, readLinksEtConfigFromEnvironment } from "./linkset";
import { validateNormalizedBankProviderResult } from "./schemas";
import type { BankProvider, BankProviderAdapter, BankProviderLookup, BankProviderResult } from "./types";

function assertTestOnly(name: string): void {
  if (process.env.NODE_ENV !== "test") {
    throw new Error(`${name} is unavailable in production and available only in tests`);
  }
}

export class UnconfiguredBankProviderAdapter implements BankProviderAdapter {
  readonly provider: BankProvider;

  constructor(provider: BankProvider) {
    this.provider = provider;
  }

  isConfigured(): boolean {
    return false;
  }

  async verify(_lookup: BankProviderLookup): Promise<BankProviderResult> {
    throw new BankVerificationError(
      "PROVIDER_NOT_CONFIGURED",
      "The bank provider adapter is not configured"
    );
  }
}

export class FixtureBankProviderAdapter implements BankProviderAdapter {
  readonly provider: BankProvider;
  private readonly response: unknown | ((lookup: BankProviderLookup) => unknown);

  constructor(
    provider: BankProvider,
    response: unknown | ((lookup: BankProviderLookup) => unknown)
  ) {
    assertTestOnly("FixtureBankProviderAdapter");
    this.provider = provider;
    this.response = response;
  }

  isConfigured(): boolean {
    return true;
  }

  async verify(lookup: BankProviderLookup): Promise<BankProviderResult> {
    const value = typeof this.response === "function" ? this.response(lookup) : this.response;
    try {
      const result = validateNormalizedBankProviderResult(this.provider, value);
      if (result.provider !== this.provider) {
        throw new Error("Provider identity mismatch");
      }
      return result;
    } catch (error) {
      if (error instanceof BankVerificationError) {
        throw error;
      }
      throw new BankVerificationError(
        "INVALID_PROVIDER_RESULT",
        "The bank provider returned an invalid normalized result",
        { cause: error }
      );
    }
  }
}

export function createProductionBankProviderAdapter(provider: BankProvider): BankProviderAdapter {
  if (!isLinksEtConfigured()) {
    // Fail closed. Without a links.et key there is no way to reach the issuing
    // bank, and a "verified" badge with no bank behind it is exactly the
    // fabricated trust signal this product exists to eliminate.
    return new UnconfiguredBankProviderAdapter(provider);
  }
  return new LinksEtBankProviderAdapter({
    provider,
    config: readLinksEtConfigFromEnvironment()
  });
}

export function createTestFixtureBankProviderAdapter(
  provider: BankProvider,
  response: unknown | ((lookup: BankProviderLookup) => unknown)
): BankProviderAdapter {
  return new FixtureBankProviderAdapter(provider, response);
}
