import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { LedgerService, SupabaseLedgerRepository } from "@/lib/ledger";

import { nodeDrawHasher } from "./canonical";
import { SupabaseDrawRepository, type DrawRepository } from "./repository";
import { DrawService, type DrawServiceOptions } from "./service";
import type { DrawHasher } from "./types";

/**
 * Assembles the production draw service. The draw engine itself needs no
 * credentials — SHA-256 and `node:crypto` are enough — so the only external
 * dependency here is the same Supabase client the ledger and banking lanes
 * already use. Nothing in this lane is unconfigured-and-faked: if the client
 * cannot be built the caller gets `null` and the route answers `503
 * not_configured`, never a fabricated draw.
 */
export function createProductionDrawService(
  client: SupabaseClient,
  options: DrawServiceOptions = {}
): DrawService {
  return new DrawService(
    new SupabaseDrawRepository(client),
    new LedgerService(new SupabaseLedgerRepository(client)),
    { hasher: nodeDrawHasher, ...options }
  );
}

export function createDrawService(
  repository: DrawRepository,
  ledger: LedgerService,
  hasher: DrawHasher = nodeDrawHasher,
  options: Omit<DrawServiceOptions, "hasher"> = {}
): DrawService {
  return new DrawService(repository, ledger, { hasher, ...options });
}
