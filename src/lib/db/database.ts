import { SyncError } from "@/lib/offline/contract";
import { DEFAULT_DATABASE_NAME, createSenedDatabase, type SenedDatabase } from "./schema";

let singleton: SenedDatabase | null = null;
let singletonName: string | null = null;

/**
 * `true` when this runtime can actually persist to IndexedDB.
 *
 * Checked rather than assumed: server rendering, unit tests without
 * `fake-indexeddb`, and locked-down browsers all reach the offline code paths.
 * Returning a boolean lets callers render an honest state instead of throwing
 * inside a React tree.
 */
export function isOfflineStorageAvailable(): boolean {
  try {
    return typeof indexedDB !== "undefined" && indexedDB !== null;
  } catch {
    return false;
  }
}

export function assertOfflineStorageAvailable(): void {
  if (!isOfflineStorageAvailable()) {
    throw new SyncError(
      "STORAGE_UNAVAILABLE",
      "IndexedDB is not available in this runtime, so nothing can be stored offline"
    );
  }
}

/**
 * The device's single store.
 *
 * Lazily constructed so importing this module during server rendering is safe:
 * nothing touches `indexedDB` until a caller actually asks for the database.
 */
export function getSenedDatabase(): SenedDatabase {
  assertOfflineStorageAvailable();
  if (!singleton || singletonName !== DEFAULT_DATABASE_NAME) {
    singleton?.close();
    singleton = createSenedDatabase(DEFAULT_DATABASE_NAME);
    singletonName = DEFAULT_DATABASE_NAME;
  }
  return singleton;
}

/** Test seam: drop the cached handle so a fresh database can be opened. */
export async function resetSenedDatabase(): Promise<void> {
  singleton?.close();
  singleton = null;
  singletonName = null;
}

/**
 * Delete a database outright. Used by tests between cases; a real treasurer
 * never loses the queue, so nothing in the app calls this.
 */
export async function deleteSenedDatabase(name: string = DEFAULT_DATABASE_NAME): Promise<void> {
  if (singletonName === name) {
    await resetSenedDatabase();
  }
  if (!isOfflineStorageAvailable()) {
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase(name);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(new SyncError("STORAGE_UNAVAILABLE", "Could not delete the local database"));
    request.onblocked = () => resolve();
  });
}

/** Normalises the two failure modes Dexie surfaces for a full or blocked store. */
export function mapStorageError(error: unknown, context: string): SyncError {
  if (error instanceof SyncError) {
    return error;
  }
  const name = error instanceof Error ? error.name : "";
  const message = error instanceof Error ? error.message : String(error);
  if (name === "QuotaExceededError") {
    return new SyncError("STORAGE_FULL", `${context} failed: this device is out of storage`, { cause: error });
  }
  return new SyncError("STORAGE_UNAVAILABLE", `${context} failed: ${message}`, { cause: error });
}
