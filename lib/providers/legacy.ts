import { and, eq, isNull, ne } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { serverLogger as logger } from "@/lib/logger";
import { legacyProviderKeys } from "@/lib/db/schema/sqlite";
import { findProvider, KEY_PLACEHOLDER, type ProviderId } from "./catalog";

/** Old bundled row id → catalog provider id. `youtube-downloader` has no
 *  catalog entry (it became the youtube-download extension, no key). */
const ID_MAP: Record<string, ProviderId> = {
  "fal-ai": "fal",
  elevenlabs: "elevenlabs",
};

export interface LegacyKeyNotice {
  /** The OLD row id — what `acknowledgeLegacyKey` takes. */
  rowId: string;
  providerId: ProviderId;
  providerName: string;
  /** The Claude add command with the stored key substituted for the placeholder. */
  command: string;
  /**
   * Both agents' commands, key substituted. When an agent's command carries
   * no placeholder (fal on Codex: the key is an env-var NAME there), the
   * `export` that puts the key into that agent's environment leads, on its
   * own line, so the box is still the whole of what the user has to run.
   */
  commands: { claude: string; codex: string };
}

function substitute(
  command: string,
  keyName: string | undefined,
  key: string,
): string {
  if (command.includes(KEY_PLACEHOLDER)) return command.split(KEY_PLACEHOLDER).join(key);
  if (keyName) return `export ${keyName}="${key}"\n${command}`;
  return command;
}

/**
 * Every rescued key the user has not acknowledged yet.
 *
 * This is the ONLY reader of `legacy_provider_keys`, and it exists for exactly
 * one screen: the user gave libi this key before libi stopped taking keys, so
 * handing it back inside a ready-to-run command is strictly better than
 * dropping it silently. `acknowledgeLegacyKey` deletes the values immediately
 * afterwards.
 *
 * A row the user never acknowledges is not kept: it is blanked when they
 * reconnect that provider themselves (`clearLegacyKeysForConnected`) and,
 * failing that, at boot once it passes `LEGACY_KEY_TTL_DAYS`
 * (`expireRescuedProviderKeys`, lib/db/migrate-providers.ts).
 */
export function pendingLegacyKeyNotices(): LegacyKeyNotice[] {
  let rows: Array<{ providerId: string; envVars: string }>;
  try {
    rows = getDb()
      .select({ providerId: legacyProviderKeys.providerId, envVars: legacyProviderKeys.envVars })
      .from(legacyProviderKeys)
      .where(and(isNull(legacyProviderKeys.shownAt), ne(legacyProviderKeys.envVars, "{}")))
      .all();
  } catch {
    return [];
  }

  const out: LegacyKeyNotice[] = [];
  for (const row of rows) {
    const providerId = ID_MAP[row.providerId];
    if (!providerId) continue;
    const def = findProvider(providerId);
    if (!def.commands) continue;
    let key = "";
    try {
      const parsed = JSON.parse(row.envVars) as Record<string, unknown>;
      const raw = def.keyName ? parsed[def.keyName] : Object.values(parsed)[0];
      key = typeof raw === "string" ? raw : "";
    } catch {
      continue;
    }
    if (!key) continue;
    const claude = substitute(def.commands.claude, def.keyName, key);
    const codex = substitute(def.commands.codex, def.keyName, key);
    out.push({
      rowId: row.providerId,
      providerId,
      providerName: def.name,
      command: claude,
      commands: { claude, codex },
    });
  }
  return out;
}

/** Mark the notice shown and DELETE the stored values. One-way. */
export function acknowledgeLegacyKey(rowId: string): void {
  blankLegacyRows([rowId]);
}

/** The single write in this module: stamp shown, drop the values. One-way. */
function blankLegacyRows(rowIds: string[]): number {
  let cleared = 0;
  const db = getDb();
  for (const rowId of rowIds) {
    const res = db
      .update(legacyProviderKeys)
      .set({ shownAt: new Date(), envVars: "{}" })
      .where(eq(legacyProviderKeys.providerId, rowId))
      .run();
    cleared += Number((res as { changes?: number }).changes ?? 0);
  }
  return cleared;
}

/**
 * The second exit, and the one that fires first in practice: the user has
 * reconnected the provider themselves, so the key libi is holding for them is
 * already in their agent's config and the notice has nothing left to offer.
 *
 * libi never runs a provider's add command itself — the user submits it in a
 * setup terminal — so the reconnection libi can actually observe is the
 * DETECTOR seeing the entry in the user's own config, which is where this is
 * called from (`GET /api/providers`).
 *
 * Never throws: it runs inside a read route whose job is to answer what is
 * connected, and a housekeeping write must not turn that into a 500.
 */
export function clearLegacyKeysForConnected(
  connected: ReadonlyArray<{ providerId: ProviderId | null }>,
): void {
  const connectedIds = new Set(connected.map((c) => c.providerId).filter(Boolean));
  if (connectedIds.size === 0) return;
  try {
    const holding = getDb()
      .select({ providerId: legacyProviderKeys.providerId })
      .from(legacyProviderKeys)
      .where(ne(legacyProviderKeys.envVars, "{}"))
      .all();
    const stale = holding
      .map((r) => r.providerId)
      .filter((rowId) => {
        const providerId = ID_MAP[rowId];
        return providerId !== undefined && connectedIds.has(providerId);
      });
    if (stale.length === 0) return;
    const cleared = blankLegacyRows(stale);
    if (cleared > 0) {
      // Row ids only, never a value.
      logger.info(
        { tag: "providers", op: "legacy_cleared_on_connect", rowIds: stale },
        "rescued provider key dropped — the user reconnected that provider themselves",
      );
    }
  } catch (err) {
    logger.warn(
      { err, tag: "providers", op: "legacy_clear_failed" },
      "could not clear rescued provider keys for reconnected providers",
    );
  }
}
