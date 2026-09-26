import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { BankVerificationError } from "./errors";
import type { BankProvider, BankReferenceVault, SealedProviderReference } from "./types";

function requireKey(value: string | undefined, name: string): Buffer {
  if (!value) {
    throw new BankVerificationError(
      "PROVIDER_NOT_CONFIGURED",
      `${name} is not configured`
    );
  }
  const key = Buffer.from(value, "base64");
  if (key.length !== 32) {
    throw new BankVerificationError("INVALID_REQUEST", `${name} must be a 32-byte base64 key`);
  }
  return key;
}

function referenceBytes(provider: BankProvider, reference: string): Buffer {
  return Buffer.from(`${provider}\u0000${reference}`, "utf8");
}

export function createProviderReferenceHmac(
  provider: BankProvider,
  reference: string,
  key: string | Buffer
): string {
  const keyBytes = typeof key === "string" ? Buffer.from(key, "utf8") : key;
  if (keyBytes.length < 32) {
    throw new BankVerificationError("INVALID_REQUEST", "Reference HMAC key is too short");
  }
  return createHmac("sha256", keyBytes).update(referenceBytes(provider, reference)).digest("hex");
}

function assertHmac(value: string, expected: string): void {
  const actualBytes = Buffer.from(value, "hex");
  const expectedBytes = Buffer.from(expected, "hex");
  if (actualBytes.length !== expectedBytes.length || !timingSafeEqual(actualBytes, expectedBytes)) {
    throw new BankVerificationError("INTEGRITY_FAILURE", "Provider reference integrity check failed");
  }
}

class AesGcmReferenceVault implements BankReferenceVault {
  private readonly encryptionKey: Buffer;
  private readonly hmacKey: Buffer;
  private readonly keyVersion: string;

  constructor(encryptionKey: Buffer, hmacKey: Buffer, keyVersion: string) {
    this.encryptionKey = encryptionKey;
    this.hmacKey = hmacKey;
    this.keyVersion = keyVersion;
  }

  async seal(provider: BankProvider, reference: string): Promise<SealedProviderReference> {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.encryptionKey, iv);
    const encrypted = Buffer.concat([cipher.update(reference, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return {
      provider,
      ciphertext: Buffer.concat([iv, tag, encrypted]).toString("base64"),
      hmac: createProviderReferenceHmac(provider, reference, this.hmacKey),
      keyVersion: this.keyVersion
    };
  }

  async open(sealed: SealedProviderReference): Promise<string> {
    try {
      const decoded = Buffer.from(sealed.ciphertext, "base64");
      if (decoded.length < 29) {
        throw new Error("Ciphertext is too short");
      }
      const iv = decoded.subarray(0, 12);
      const tag = decoded.subarray(12, 28);
      const encrypted = decoded.subarray(28);
      const decipher = createDecipheriv("aes-256-gcm", this.encryptionKey, iv);
      decipher.setAuthTag(tag);
      const reference = Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
      assertHmac(
        sealed.hmac,
        createProviderReferenceHmac(sealed.provider, reference, this.hmacKey)
      );
      return reference;
    } catch (error) {
      if (error instanceof BankVerificationError) {
        throw error;
      }
      throw new BankVerificationError(
        "INTEGRITY_FAILURE",
        "Provider reference could not be opened",
        { cause: error }
      );
    }
  }
}

export function createAesGcmReferenceVaultFromEnvironment(): BankReferenceVault {
  const encryptionKey = requireKey(process.env.BANK_REFERENCE_ENCRYPTION_KEY, "BANK_REFERENCE_ENCRYPTION_KEY");
  const hmacKey = requireKey(process.env.BANK_REFERENCE_HMAC_KEY, "BANK_REFERENCE_HMAC_KEY");
  const keyVersion = process.env.BANK_REFERENCE_KEY_VERSION?.trim() || "v1";
  if (!/^[A-Za-z0-9._-]{1,32}$/.test(keyVersion)) {
    throw new BankVerificationError("INVALID_REQUEST", "BANK_REFERENCE_KEY_VERSION is invalid");
  }
  return new AesGcmReferenceVault(encryptionKey, hmacKey, keyVersion);
}

export class InMemoryReferenceVault implements BankReferenceVault {
  private readonly values = new Map<string, string>();
  private readonly key: Buffer;

  constructor(key?: string | Buffer) {
    if (process.env.NODE_ENV !== "development" && process.env.NODE_ENV !== "test") {
      throw new Error("InMemoryReferenceVault is unavailable outside local development");
    }
    this.key = typeof key === "string" ? Buffer.from(key, "utf8") : key ?? randomBytes(32);
    if (this.key.length < 32) {
      throw new BankVerificationError("INVALID_REQUEST", "Reference HMAC key is too short");
    }
  }

  async seal(provider: BankProvider, reference: string): Promise<SealedProviderReference> {
    const hmac = createProviderReferenceHmac(provider, reference, this.key);
    this.values.set(hmac, reference);
    return {
      provider,
      ciphertext: Buffer.from(reference, "utf8").toString("base64"),
      hmac,
      keyVersion: "test-v1"
    };
  }

  async open(sealed: SealedProviderReference): Promise<string> {
    const reference = this.values.get(sealed.hmac);
    if (reference === undefined) {
      throw new BankVerificationError("INTEGRITY_FAILURE", "Provider reference is unavailable");
    }
    return reference;
  }
}
