import { sql } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { serverLogger as logger } from "@/lib/logger";

/** The bundled third-party rows this change removes. */
const REMOVED_BUNDLED_IDS = ["fal-ai", "elevenlabs", "youtube-downloader"] as const;

/**
 * How long a rescued key may sit unclaimed before libi blanks it anyway.
 *
 * The rescue exists so an upgrading user does not silently lose the key they
 * had given libi — it is a hand-back, not a store, and libi holds no
 * provider key. Without a deadline the hand-back never ends: a user who never
 * opens the panel keeps a live API key in libi's database for as long as the
 * install lives. Seven days is a week of ordinary use to notice the notice;
 * after that the value goes and the user re-copies it from the vendor, which
 * is where it lives anyway.
 */
export const LEGACY_KEY_TTL_DAYS = 7;

/**
 * Blank every rescued key older than the TTL. Idempotent, and safe to run on
 * every boot: `env_vars <> '{}'` means an already-cleared row is not rewritten,
 * and stamping `shown_at` keeps the notice from re-appearing empty.
 *
 * Deliberately NOT part of the disk sweep in
 * `lib/server/lifecycle/housekeeping.ts`: that one is fire-and-forget in
 * Category B and `LIBI_SKIP_HOUSEKEEPING=1` turns it off. An escape hatch for
 * reclaiming disk must not double as an escape hatch for keeping a secret.
 */
export function expireRescuedProviderKeys(
  tx: Pick<BetterSQLite3Database<Record<string, unknown>>, "run">,
  now: number = Date.now(),
): number {
  const cutoffSeconds = Math.floor(now / 1000) - LEGACY_KEY_TTL_DAYS * 24 * 60 * 60;
  const res = tx.run(
    sql`UPDATE legacy_provider_keys
        SET env_vars = '{}', shown_at = COALESCE(shown_at, unixepoch())
        WHERE rescued_at < ${cutoffSeconds} AND env_vars <> '{}'`,
  );
  return Number(res.changes ?? 0);
}

/**
 * The DATA half of the providers migration. Drizzle emits DDL
 * only, and `AGENTS.md` forbids hand-editing a generated migration — so the
 * row deletes and the one-shot key rescue live here, run once per boot
 * between `migrate()` and `seedDatabase()` (lib/db/client.ts).
 *
 * Order matters: the keys are copied out BEFORE the rows are deleted. Both
 * steps are idempotent (`INSERT OR IGNORE`, deletes of rows that are already
 * gone), so a second boot is a no-op — and an acknowledged notice, whose
 * values were blanked, is never resurrected because the row still exists.
 */
export function migrateProviderRows(db: BetterSQLite3Database<Record<string, unknown>>): void {
  let rescued = 0;
  let expired = 0;
  let deletedBundled = 0;
  let deletedCustom = 0;

  db.transaction((tx) => {
    for (const id of REMOVED_BUNDLED_IDS) {
      const row = tx.all<{ env_vars: string | null }>(
        sql`SELECT env_vars FROM mcp_servers WHERE id = ${id}`,
      )[0];
      if (!row?.env_vars) continue;
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(row.env_vars) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (!parsed || typeof parsed !== "object") continue;
      const nonEmpty = Object.entries(parsed).filter(
        ([, v]) => typeof v === "string" && v.length > 0,
      );
      if (nonEmpty.length === 0) continue;
      const res = tx.run(
        sql`INSERT OR IGNORE INTO legacy_provider_keys (provider_id, env_vars, shown_at)
            VALUES (${id}, ${JSON.stringify(Object.fromEntries(nonEmpty))}, NULL)`,
      );
      rescued += Number(res.changes ?? 0);
    }

    for (const id of REMOVED_BUNDLED_IDS) {
      const res = tx.run(sql`DELETE FROM mcp_servers WHERE id = ${id}`);
      deletedBundled += Number(res.changes ?? 0);
    }
    // Every user-added row. libi manages no third-party MCP, and the UI
    // and tools that used to manage these rows are gone — left in place they
    // would be invisible and unremovable forever. The user's own agent config
    // is where these belong now, and libi never wrote there.
    const custom = tx.run(sql`DELETE FROM mcp_servers WHERE bundled = 0`);
    deletedCustom = Number(custom.changes ?? 0);

    // The other end of the rescue. A key lifted out on some earlier boot and
    // never claimed does not get to live here forever — see
    // `expireRescuedProviderKeys`. Rows rescued on THIS boot are stamped
    // `rescued_at = now`, so they are never caught by their own migration.
    expired = expireRescuedProviderKeys(tx);
  });

  if (rescued || expired || deletedBundled || deletedCustom) {
    // Counts only — never the values.
    logger.info(
      { tag: "providers", op: "migrate_rows", rescued, expired, deletedBundled, deletedCustom },
      "removed libi's third-party MCP rows",
    );
  }
}
