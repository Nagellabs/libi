import { and, eq, sql } from "drizzle-orm";
import { getDb } from "./client";
import { settings } from "./schema";
import { DEFAULT_ASPECT_RATIO_ID, ratioById } from "@/lib/composition/aspect-ratio";
import {
  type AnalyticsSettings,
  parseAnalyticsSettings,
  mergeAnalyticsSettings,
  markMilestone,
} from "@/lib/analytics/settings-logic";
import { crashReportChoiceAllowsReporting } from "@/lib/sentry/enabled";
import { isSocialProviderId, type SocialProviderId, type InstagramPostType } from "@/lib/social/catalog";
import type { AccountMusicFacts } from "@/lib/social/music-policy";

export type { AnalyticsSettings };

export interface AppSettings {
  preferredAgent: string | null;
  panelChatSize: number;
  panelEditorSize: number;
  panelResourcesSize: number;
  panelChatVisible: boolean;
  panelResourcesVisible: boolean;
  agentApprovalModes: string | null;
  agentModelPreferences: string | null;
  onboardingPersona: string | null;
  personaSelectedAt: Date | null;
  agentEverConnected: boolean;
  /** Set once, server-side, the first time an agent connects. Null = the
   *  first-run demo chip has never been armed. See lib/sessions/session-manager.ts#markAgentConnected. */
  onboardingDemoOfferedAt: Date | null;
  /** Set once the user dismisses OR takes the demo offer — final, and kept
   *  independent of onboardingDemoOfferedAt so a dismissal is never confused
   *  with "never offered". */
  onboardingDemoDismissedAt: Date | null;
  /** The setup wizard's sign-in confirmation per agent — see lib/agents/sign-in-confirmation.ts. */
  claudeSignInConfirmedAt: Date | null;
  codexSignInConfirmedAt: Date | null;
  /** The Agents tab's setup wizard: when an agent was FIRST picked in it (null =
   *  never), and which agent is being set up — the latest pick until the wizard
   *  is finished. See app/api/onboarding/state/route.ts. */
  agentWizardChosenAt: Date | null;
  agentWizardAgent: string | null;
  /** When the setup wizard first reached its end (Open chat succeeded). Null = never. */
  agentWizardFinishedAt: Date | null;
}

const DEFAULTS: AppSettings = {
  preferredAgent: null,
  panelChatSize: 40,
  panelEditorSize: 40,
  panelResourcesSize: 20,
  panelChatVisible: true,
  panelResourcesVisible: false,
  agentApprovalModes: null,
  agentModelPreferences: null,
  onboardingPersona: null,
  personaSelectedAt: null,
  agentEverConnected: false,
  onboardingDemoOfferedAt: null,
  onboardingDemoDismissedAt: null,
  claudeSignInConfirmedAt: null,
  codexSignInConfirmedAt: null,
  agentWizardChosenAt: null,
  agentWizardAgent: null,
  agentWizardFinishedAt: null,
};

/**
 * Read the app settings (single row, id=1).
 * Auto-creates the row with defaults if it doesn't exist.
 */
export function getSettings(): AppSettings {
  const db = getDb();

  const [row] = db.select().from(settings).where(eq(settings.id, 1)).limit(1).all();

  if (!row) {
    db.insert(settings).values({ id: 1 }).run();
    return { ...DEFAULTS };
  }

  return {
    preferredAgent: row.preferredAgent ?? null,
    panelChatSize: row.panelChatSize,
    panelEditorSize: row.panelEditorSize,
    panelResourcesSize: row.panelResourcesSize,
    panelChatVisible: row.panelChatVisible,
    panelResourcesVisible: row.panelResourcesVisible,
    agentApprovalModes: row.agentApprovalModes ?? null,
    agentModelPreferences: row.agentModelPreferences ?? null,
    onboardingPersona: row.onboardingPersona ?? null,
    personaSelectedAt: row.personaSelectedAt ?? null,
    agentEverConnected: row.agentEverConnected,
    onboardingDemoOfferedAt: row.onboardingDemoOfferedAt ?? null,
    onboardingDemoDismissedAt: row.onboardingDemoDismissedAt ?? null,
    claudeSignInConfirmedAt: row.claudeSignInConfirmedAt ?? null,
    codexSignInConfirmedAt: row.codexSignInConfirmedAt ?? null,
    agentWizardChosenAt: row.agentWizardChosenAt ?? null,
    agentWizardAgent: row.agentWizardAgent ?? null,
    agentWizardFinishedAt: row.agentWizardFinishedAt ?? null,
  };
}

/**
 * Update specific settings fields. Only provided fields are updated.
 */
export function updateSettings(partial: Partial<AppSettings>): void {
  const db = getDb();

  // Build the SET clause from provided fields
  const set: Record<string, unknown> = { updatedAt: new Date() };

  if (partial.preferredAgent !== undefined) set.preferredAgent = partial.preferredAgent;
  if (partial.panelChatSize !== undefined) set.panelChatSize = partial.panelChatSize;
  if (partial.panelEditorSize !== undefined) set.panelEditorSize = partial.panelEditorSize;
  if (partial.panelResourcesSize !== undefined) set.panelResourcesSize = partial.panelResourcesSize;
  if (partial.panelChatVisible !== undefined) set.panelChatVisible = partial.panelChatVisible;
  if (partial.panelResourcesVisible !== undefined) set.panelResourcesVisible = partial.panelResourcesVisible;
  if (partial.agentApprovalModes !== undefined) set.agentApprovalModes = partial.agentApprovalModes;
  if (partial.agentModelPreferences !== undefined) set.agentModelPreferences = partial.agentModelPreferences;
  if (partial.onboardingPersona !== undefined) set.onboardingPersona = partial.onboardingPersona;
  if (partial.personaSelectedAt !== undefined) set.personaSelectedAt = partial.personaSelectedAt;
  if (partial.agentEverConnected !== undefined) set.agentEverConnected = partial.agentEverConnected;
  if (partial.onboardingDemoOfferedAt !== undefined) set.onboardingDemoOfferedAt = partial.onboardingDemoOfferedAt;
  if (partial.onboardingDemoDismissedAt !== undefined) set.onboardingDemoDismissedAt = partial.onboardingDemoDismissedAt;
  if (partial.claudeSignInConfirmedAt !== undefined) set.claudeSignInConfirmedAt = partial.claudeSignInConfirmedAt;
  if (partial.codexSignInConfirmedAt !== undefined) set.codexSignInConfirmedAt = partial.codexSignInConfirmedAt;
  if (partial.agentWizardChosenAt !== undefined) set.agentWizardChosenAt = partial.agentWizardChosenAt;
  if (partial.agentWizardAgent !== undefined) set.agentWizardAgent = partial.agentWizardAgent;
  if (partial.agentWizardFinishedAt !== undefined) set.agentWizardFinishedAt = partial.agentWizardFinishedAt;

  // Upsert: insert defaults if row doesn't exist, update if it does
  db.insert(settings)
    .values({ id: 1, ...set })
    .onConflictDoUpdate({ target: settings.id, set })
    .run();
}

// ---------------------------------------------------------------------------
// Notifications setting (typed helpers over the settings.notifications JSON column)
// ---------------------------------------------------------------------------

export type NotificationsSetting = {
  /** Push a system notification when a background job completes while the window is backgrounded. */
  backgroundJobComplete: boolean;
};

const NOTIFICATIONS_DEFAULTS: NotificationsSetting = {
  backgroundJobComplete: true,
};

/**
 * Read the notifications setting. Returns defaults if the row is missing,
 * the column is null/empty, or the stored JSON is malformed / wrong-shape.
 */
export function getNotificationsSetting(): NotificationsSetting {
  const db = getDb();
  const [row] = db
    .select({ notifications: settings.notifications })
    .from(settings)
    .where(eq(settings.id, 1))
    .limit(1)
    .all();

  const raw = row?.notifications;
  if (!raw) return { ...NOTIFICATIONS_DEFAULTS };

  try {
    const parsed = JSON.parse(raw) as Partial<NotificationsSetting> | null;
    if (!parsed || typeof parsed !== "object") return { ...NOTIFICATIONS_DEFAULTS };
    if (typeof parsed.backgroundJobComplete !== "boolean") {
      return { ...NOTIFICATIONS_DEFAULTS };
    }
    return { backgroundJobComplete: parsed.backgroundJobComplete };
  } catch {
    return { ...NOTIFICATIONS_DEFAULTS };
  }
}

/**
 * Persist the notifications setting as a JSON string in the settings table.
 * Upserts the single-row settings record if it doesn't already exist.
 */
export function setNotificationsSetting(s: NotificationsSetting): void {
  const db = getDb();
  const value = JSON.stringify(s);
  const set = { notifications: value, updatedAt: new Date() };

  db.insert(settings)
    .values({ id: 1, ...set })
    .onConflictDoUpdate({ target: settings.id, set })
    .run();
}

// ---------------------------------------------------------------------------
// Export defaults setting (default format + default qualities). Exports are
// saved in the piece (`<storage>/<pieceId>/exports/`, lib/exports/paths.ts);
// a `folder` left in older stored JSON is ignored.
// ---------------------------------------------------------------------------

import type { GraphicsQuality } from "@/lib/engine/types";

export type ExportDefaultsSetting = {
  format: "mp4" | "webm";
  /** Media (videos & images) resolution default. */
  quality: "source" | "1080p" | "1440p" | "4k";
  /** Text/code/3D resolution default. Absent in legacy stored JSON ⇒ "4k". */
  graphicsQuality: GraphicsQuality;
};

const EXPORT_DEFAULTS_FALLBACK: ExportDefaultsSetting = {
  format: "mp4",
  quality: "source",
  graphicsQuality: "4k",
};

/** Read the export defaults. Falls back to MP4/Source/4K if the row is
 *  missing, the column is empty, or the JSON is malformed. */
export function getExportDefaults(): ExportDefaultsSetting {
  const db = getDb();
  const [row] = db
    .select({ exportDefaults: settings.exportDefaults })
    .from(settings)
    .where(eq(settings.id, 1))
    .limit(1)
    .all();

  const raw = row?.exportDefaults;
  if (!raw) return { ...EXPORT_DEFAULTS_FALLBACK };

  try {
    const parsed = JSON.parse(raw) as Partial<ExportDefaultsSetting> | null;
    if (!parsed || typeof parsed !== "object") return { ...EXPORT_DEFAULTS_FALLBACK };
    return {
      format: parsed.format === "webm" ? "webm" : "mp4",
      quality:
        parsed.quality === "1080p" || parsed.quality === "1440p" || parsed.quality === "4k"
          ? parsed.quality
          : "source",
      graphicsQuality:
        parsed.graphicsQuality === "1080p" || parsed.graphicsQuality === "1440p" || parsed.graphicsQuality === "4k"
          ? parsed.graphicsQuality
          : "4k",
    };
  } catch {
    return { ...EXPORT_DEFAULTS_FALLBACK };
  }
}

/** Persist the export defaults as JSON in the settings table. */
export function setExportDefaults(s: ExportDefaultsSetting): void {
  const db = getDb();
  const value = JSON.stringify(s);
  const set = { exportDefaults: value, updatedAt: new Date() };

  db.insert(settings)
    .values({ id: 1, ...set })
    .onConflictDoUpdate({ target: settings.id, set })
    .run();
}

// ---------------------------------------------------------------------------
// Piece defaults setting (default aspect ratio applied to NEW pieces)
// ---------------------------------------------------------------------------

/** The user's defaults for NEWLY CREATED pieces. Never applied retroactively. */
export type PieceDefaultsSetting = {
  /** A catalog id from lib/composition/aspect-ratio.ts, e.g. "9:16". */
  aspectRatioId: string;
};

const PIECE_DEFAULTS_FALLBACK: PieceDefaultsSetting = {
  aspectRatioId: DEFAULT_ASPECT_RATIO_ID,
};

/**
 * Read the piece defaults. Falls back to 9:16 portrait when the row is
 * missing, the column is empty, the JSON is malformed, or the stored id is
 * not in the catalog.
 *
 * The catalog check is not paranoia: an id retired in a later version would
 * otherwise reach `dimensionsFor()`, return null, and create a piece with no
 * usable dimensions.
 */
export function getPieceDefaults(): PieceDefaultsSetting {
  const db = getDb();
  const [row] = db
    .select({ pieceDefaults: settings.pieceDefaults })
    .from(settings)
    .where(eq(settings.id, 1))
    .limit(1)
    .all();

  const raw = row?.pieceDefaults;
  if (!raw) return { ...PIECE_DEFAULTS_FALLBACK };

  try {
    const parsed = JSON.parse(raw) as Partial<PieceDefaultsSetting> | null;
    if (!parsed || typeof parsed !== "object") return { ...PIECE_DEFAULTS_FALLBACK };
    const id = parsed.aspectRatioId;
    if (typeof id !== "string" || !ratioById(id)) return { ...PIECE_DEFAULTS_FALLBACK };
    return { aspectRatioId: id };
  } catch {
    return { ...PIECE_DEFAULTS_FALLBACK };
  }
}

/** Persist the piece defaults as JSON in the settings table. */
export function setPieceDefaults(s: PieceDefaultsSetting): void {
  const db = getDb();
  const set = { pieceDefaults: JSON.stringify(s), updatedAt: new Date() };
  db.insert(settings)
    .values({ id: 1, ...set })
    .onConflictDoUpdate({ target: settings.id, set })
    .run();
}

// ---------------------------------------------------------------------------
// Legacy canvas-scene notice (once per piece; see hooks/editor/use-legacy-scenes-notice.ts)
// ---------------------------------------------------------------------------

function readLegacyScenesNoticed(): string[] {
  const [row] = getDb()
    .select({ legacyScenesNoticed: settings.legacyScenesNoticed })
    .from(settings)
    .where(eq(settings.id, 1))
    .limit(1)
    .all();
  const raw = row?.legacyScenesNoticed;
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

function writeLegacyScenesNoticed(ids: string[]): void {
  const set = { legacyScenesNoticed: JSON.stringify(ids), updatedAt: new Date() };
  getDb().insert(settings).values({ id: 1, ...set }).onConflictDoUpdate({ target: settings.id, set }).run();
}

/** Has the user already been told this piece's legacy canvas scenes were not loaded? */
export function isLegacyScenesNoticed(pieceId: string): boolean {
  return readLegacyScenesNoticed().includes(pieceId);
}

/** Record that the user has been told. Idempotent. */
export function markLegacyScenesNoticed(pieceId: string): void {
  const ids = readLegacyScenesNoticed();
  if (!ids.includes(pieceId)) writeLegacyScenesNoticed([...ids, pieceId]);
}

/** Drop a deleted piece's id (lib/pieces/delete-piece.ts). No-op when absent. */
export function forgetLegacyScenesNoticed(pieceId: string): void {
  const ids = readLegacyScenesNoticed();
  if (ids.includes(pieceId)) writeLegacyScenesNoticed(ids.filter((id) => id !== pieceId));
}

// ---------------------------------------------------------------------------
// Bundled-skill digest cache (per-app-version, see mcp/skills/digest.ts)
// ---------------------------------------------------------------------------

import type { SkillDigestCache } from "@/mcp/skills/digest";

/** Read the cached bundled-skill digests. Null when missing, malformed,
 *  or wrong-shape — callers treat null as "recompute". */
export function getSkillDigestCacheSetting(): SkillDigestCache | null {
  const db = getDb();
  const [row] = db
    .select({ skillDigestCache: settings.skillDigestCache })
    .from(settings)
    .where(eq(settings.id, 1))
    .limit(1)
    .all();

  const raw = row?.skillDigestCache;
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<SkillDigestCache> | null;
    if (!parsed || typeof parsed !== "object") return null;
    if (typeof parsed.version !== "string" || !parsed.version) return null;
    if (!parsed.digests || typeof parsed.digests !== "object") return null;
    return { version: parsed.version, digests: parsed.digests as Record<string, string> };
  } catch {
    return null;
  }
}

/** Persist the bundled-skill digest cache as JSON in the settings table. */
export function setSkillDigestCacheSetting(c: SkillDigestCache): void {
  const db = getDb();
  const set = { skillDigestCache: JSON.stringify(c), updatedAt: new Date() };
  db.insert(settings)
    .values({ id: 1, ...set })
    .onConflictDoUpdate({ target: settings.id, set })
    .run();
}

// ---------------------------------------------------------------------------
// Analytics settings (typed helpers over the settings.analytics JSON column)
// ---------------------------------------------------------------------------

export function getAnalyticsSettings(): AnalyticsSettings {
  const db = getDb();
  const [row] = db
    .select({ analytics: settings.analytics })
    .from(settings)
    .where(eq(settings.id, 1))
    .limit(1)
    .all();
  return parseAnalyticsSettings(row?.analytics ?? null);
}

export function setAnalyticsSettings(partial: Partial<AnalyticsSettings>): AnalyticsSettings {
  const db = getDb();
  const next = mergeAnalyticsSettings(getAnalyticsSettings(), partial);
  const set = { analytics: JSON.stringify(next), updatedAt: new Date() };
  db.insert(settings)
    .values({ id: 1, ...set })
    .onConflictDoUpdate({ target: settings.id, set })
    .run();
  return next;
}

/** Return the per-install analytics UUID, generating + persisting it on first call. */
export function getOrCreateAnalyticsUserId(): string {
  const cur = getAnalyticsSettings();
  if (cur.userId) return cur.userId;
  const userId = crypto.randomUUID();
  setAnalyticsSettings({ userId });
  return userId;
}

/** Mark an activation milestone; returns true only the first time. */
export function markAnalyticsMilestoneOnce(name: string): boolean {
  const { settings: next, added } = markMilestone(getAnalyticsSettings(), name);
  if (added) setAnalyticsSettings({ milestones: next.milestones });
  return added;
}

// ---------------------------------------------------------------------------
// Crash report settings (typed helpers over the settings.crashReports JSON column)
// ---------------------------------------------------------------------------

export type CrashReportChoice = "unset" | "on" | "off";

export interface CrashReportSettings {
  choice: CrashReportChoice;
  /** ms epoch when the user last made an explicit choice; null while "unset". */
  decidedAt: number | null;
}

const CRASH_REPORT_DEFAULTS: CrashReportSettings = {
  choice: "unset",
  decidedAt: null,
};

/**
 * Parse the persisted crash-report settings. Tolerant of null, malformed
 * JSON, and unknown `choice` values — any of those return the default.
 */
export function parseCrashReportSettings(raw: string | null): CrashReportSettings {
  if (!raw) return { ...CRASH_REPORT_DEFAULTS };
  try {
    const parsed = JSON.parse(raw) as Partial<CrashReportSettings> | null;
    if (!parsed || typeof parsed !== "object") return { ...CRASH_REPORT_DEFAULTS };
    const choice = parsed.choice;
    if (choice !== "unset" && choice !== "on" && choice !== "off") {
      return { ...CRASH_REPORT_DEFAULTS };
    }
    const decidedAt = typeof parsed.decidedAt === "number" ? parsed.decidedAt : null;
    return { choice, decidedAt };
  } catch {
    return { ...CRASH_REPORT_DEFAULTS };
  }
}

/** Read the crash-report settings. Returns defaults if the row is missing,
 *  the column is null/empty, or the stored JSON is malformed / wrong-shape. */
export function getCrashReportSettings(): CrashReportSettings {
  const db = getDb();
  const [row] = db
    .select({ crashReports: settings.crashReports })
    .from(settings)
    .where(eq(settings.id, 1))
    .limit(1)
    .all();
  return parseCrashReportSettings(row?.crashReports ?? null);
}

/** Persist the crash-report settings as JSON in the settings table. */
export function setCrashReportSettings(next: CrashReportSettings): CrashReportSettings {
  const db = getDb();
  const value = JSON.stringify(next);
  const set = { crashReports: value, updatedAt: new Date() };
  db.insert(settings)
    .values({ id: 1, ...set })
    .onConflictDoUpdate({ target: settings.id, set })
    .run();
  return next;
}

/** "unset" means we have not asked yet, and libi currently reports by default,
 *  so it resolves to true. Only an explicit "off" disables. Delegates to
 *  lib/sentry/enabled.ts#crashReportChoiceAllowsReporting so this predicate
 *  can't drift from the one the Sentry hooks actually gate on. */
export function crashReportsAllowed(s: CrashReportSettings): boolean {
  return crashReportChoiceAllowsReporting(s.choice);
}

// ---------------------------------------------------------------------------
// Social settings (chosen provider + defaults). Never a token.
// ---------------------------------------------------------------------------

export type SocialSettings = {
  providerId: SocialProviderId | null;
  /** IANA zone; null = the OS zone (`Intl.DateTimeFormat().resolvedOptions().timeZone`). */
  timezone: string | null;
  defaults: { instagramType: InstagramPostType; aiLabel: boolean };
  pollSeconds: 30;
  /** Per account, what libi knows about its music (spec §6.3, D8), keyed
   *  "<providerId>:<accountId>". Absent when empty. Detected facts are
   *  refreshed by `lib/social/music-facts.ts`; a user-set TikTok kind is never
   *  overwritten by detection. */
  accountFacts?: Record<string, AccountMusicFacts>;
};

const SOCIAL_FALLBACK: SocialSettings = {
  providerId: null,
  timezone: null,
  defaults: { instagramType: "reel", aiLabel: true },
  pollSeconds: 30,
};

/** Tolerant parse of the stored `accountFacts` map: an entry with no
 *  recognizable fact (junk, an unknown `tiktokKind.value`, …) is dropped
 *  rather than kept malformed or thrown away wholesale. */
function parseAccountFacts(raw: unknown): Record<string, AccountMusicFacts> {
  const out: Record<string, AccountMusicFacts> = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [key, v] of Object.entries(raw as Record<string, unknown>)) {
    const f = (v ?? {}) as Record<string, Record<string, unknown> | undefined>;
    const facts: AccountMusicFacts = {};
    const k = f.tiktokKind;
    if (k && (k.value === "business" || k.value === "personal") && (k.source === "detected" || k.source === "user") && typeof k.checkedAt === "string") {
      facts.tiktokKind = { value: k.value, source: k.source, checkedAt: k.checkedAt };
    }
    const i = f.instagramFacebookLogin;
    if (i && typeof i.value === "boolean" && typeof i.checkedAt === "string") {
      facts.instagramFacebookLogin = { value: i.value, source: "detected", checkedAt: i.checkedAt };
    }
    if (facts.tiktokKind || facts.instagramFacebookLogin) out[key] = facts;
  }
  return out;
}

/** Read the social settings. Falls back to no provider / OS timezone / reel
 *  + AI-label-on defaults if the row is missing, the column is empty, the
 *  JSON is malformed, or the stored provider id is not in the catalog. */
export function getSocialSettings(): SocialSettings {
  const db = getDb();
  const [row] = db.select({ social: settings.social }).from(settings).where(eq(settings.id, 1)).limit(1).all();
  if (!row?.social) return { ...SOCIAL_FALLBACK, defaults: { ...SOCIAL_FALLBACK.defaults } };
  try {
    const p = JSON.parse(row.social) as Partial<SocialSettings> | null;
    if (!p || typeof p !== "object") return { ...SOCIAL_FALLBACK, defaults: { ...SOCIAL_FALLBACK.defaults } };
    const d = (p.defaults ?? {}) as Partial<SocialSettings["defaults"]>;
    return {
      providerId: isSocialProviderId(p.providerId) ? p.providerId : null,
      timezone: typeof p.timezone === "string" && p.timezone ? p.timezone : null,
      defaults: {
        instagramType: d.instagramType === "feed" || d.instagramType === "story" ? d.instagramType : "reel",
        aiLabel: d.aiLabel !== false,
      },
      pollSeconds: 30,
      ...(() => {
        const af = parseAccountFacts(p.accountFacts);
        return Object.keys(af).length ? { accountFacts: af } : {};
      })(),
    };
  } catch {
    return { ...SOCIAL_FALLBACK, defaults: { ...SOCIAL_FALLBACK.defaults } };
  }
}

/** Persist the social settings. `accountFacts` is kept as stored when the
 *  caller does not send it — the settings PUT never does. */
export function setSocialSettings(s: SocialSettings): void {
  const facts = s.accountFacts ?? getSocialSettings().accountFacts;
  const next: SocialSettings = { ...s, ...(facts && Object.keys(facts).length ? { accountFacts: facts } : {}) };
  if (!next.accountFacts) delete next.accountFacts;
  const db = getDb();
  const set = { social: JSON.stringify(next), updatedAt: new Date() };
  db.insert(settings).values({ id: 1, ...set }).onConflictDoUpdate({ target: settings.id, set }).run();
}

export function getAccountMusicFacts(key: string): AccountMusicFacts {
  return getSocialSettings().accountFacts?.[key] ?? {};
}

export function setAccountMusicFacts(key: string, facts: AccountMusicFacts): void {
  const s = getSocialSettings();
  const all = { ...(s.accountFacts ?? {}), [key]: facts };
  setSocialSettings({ ...s, accountFacts: parseAccountFacts(all) });
}

// ---------------------------------------------------------------------------
// Templates creator identity (the public catalog's creator key)
//
// The key is a bearer secret: whoever holds it can edit this install's
// published templates. It is never logged, never sent to analytics, and never
// part of getSettings() / GET /api/settings — only POST
// /api/templates/cloud/key/reveal (Settings → General's explicit Reveal or
// Copy; a POST, so the proxy's origin and DNS-rebinding gate covers it)
// returns it.
// ---------------------------------------------------------------------------

import { PRODUCTION_SITE_URL } from "@/lib/site-url";
import { TEST_MODE_SOURCE } from "@/lib/templates/cloud/constants";
import { generateDefaultNickname } from "@/lib/templates/cloud/default-nickname";
import { CREATOR_KEY_PATTERN, authorIdFromKey, generateCreatorKey } from "@/lib/templates/cloud/identity";
import { serverLogger as logger } from "@/lib/logger";
import { registerLiveSecret } from "@/lib/security/secret-scrub";
import { isTestMode } from "@/lib/test-mode";

/**
 * The stored creator identity moved under the caller: another key was
 * imported, or another writer saved first. Nothing was written; the caller
 * re-reads before deciding anything. Routes answer it with 409.
 */
export class TemplatesAuthorChangedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TemplatesAuthorChangedError";
  }
}

/**
 * A write of the creator identity failed in the database (busy past the wait,
 * disk full, read-only, ...). Thrown IN PLACE OF the driver's error, never
 * wrapping it: drizzle's `DrizzleQueryError` message is "Failed query: ...
 * params: ..." and every one of these statements binds the key, so the
 * original would carry it into the job row, the logs, the agent's tool result
 * and Sentry. Only the SQLite code (a fixed `SQLITE_*` word) is kept, and
 * there is deliberately no `cause`.
 */
export class TemplatesAuthorWriteError extends Error {
  readonly sqliteCode: string | null;
  constructor(sqliteCode: string | null) {
    super(`could not save the creator identity${sqliteCode ? ` (${sqliteCode})` : ""}`);
    this.name = "TemplatesAuthorWriteError";
    this.sqliteCode = sqliteCode;
  }
}

const SQLITE_CODE = /^SQLITE_[A-Z_]{1,40}$/;

function sqliteCodeOf(err: unknown): string | null {
  const e = err as { code?: unknown; cause?: { code?: unknown } } | null;
  const code = e?.cause?.code ?? e?.code;
  return typeof code === "string" && SQLITE_CODE.test(code) ? code : null;
}

/** Run one statement that binds the key; any failure but a compare-and-set loss leaves as a `TemplatesAuthorWriteError`. */
function keyBoundWrite<T>(write: () => T): T {
  try {
    return write();
  } catch (err) {
    if (err instanceof TemplatesAuthorChangedError) throw err;
    throw new TemplatesAuthorWriteError(sqliteCodeOf(err));
  }
}

/**
 * The settings row the identity lives in. Test mode (`LIBI_TEST_MODE`) shares
 * LIBI_HOME with the user's real studio, but talks to the fixture catalog —
 * so its identity, and the fixture nickname a test run sets, live in a row of
 * their own. Test mode never reads or writes the production identity, and a
 * normal boot never sees what a test run left. Nothing else reads row 2: every
 * other setting is read and written at `id = 1`.
 */
const PRODUCTION_AUTHOR_ROW = 1;
const TEST_MODE_AUTHOR_ROW = 2;

function authorRow(): number {
  return isTestMode() ? TEST_MODE_AUTHOR_ROW : PRODUCTION_AUTHOR_ROW;
}

export interface TemplatesAuthorSetting {
  /** 43 chars base64url. Anyone holding it can edit this install's published templates. */
  key: string;
  /** Always derived from `key` on read — a stored value is never trusted. */
  authorId: string;
  nickname: string | null;
  createdAt: number;
}

function parseTemplatesAuthor(raw: string | null): TemplatesAuthorSetting | null {
  if (!raw) return null;
  try {
    const p = JSON.parse(raw) as Partial<TemplatesAuthorSetting> | null;
    if (!p || typeof p !== "object") return null;
    if (typeof p.key !== "string" || !CREATOR_KEY_PATTERN.test(p.key)) return null;
    // Whatever this process now holds, the logger and Sentry mask.
    registerLiveSecret(p.key);
    return {
      key: p.key,
      authorId: authorIdFromKey(p.key),
      nickname: typeof p.nickname === "string" && p.nickname ? p.nickname : null,
      createdAt: typeof p.createdAt === "number" ? p.createdAt : 0,
    };
  } catch {
    return null;
  }
}

/**
 * Each templates catalog keeps its own nickname for a key (the site's
 * `authors/<id>`), and a dev build can switch catalogs (review M4). The
 * identity's `nickname` field is PRODUCTION's, in every row; every other
 * catalog's — a development site's, and test mode's fixture (review I1: test
 * mode shares LIBI_HOME with a normal boot) — is cached under
 * `catalogNicknames[<source>]` in the same JSON, so a nickname learned from
 * or set on another catalog never becomes the first public name on
 * production. A catalog with no nickname of its own reads the production one
 * (the default, or the user's production name): production's name may go to
 * another catalog, never the reverse. The map belongs to the key: an import,
 * which writes a fresh identity, drops it.
 *
 * `source` omitted is the catalog this mode reads by default: production's,
 * or in test mode the fixture's.
 */
function isMainNicknameSlot(source: string | undefined): boolean {
  return nicknameSlot(source) === PRODUCTION_SITE_URL;
}

function nicknameSlot(source: string | undefined): string {
  return source ?? (isTestMode() ? TEST_MODE_SOURCE : PRODUCTION_SITE_URL);
}

/** The JSON path of `source`'s own nickname; null for a source that can't be quoted as a path key (a catalog source — an origin or "test-mode" — never has a quote or a backslash). */
function catalogNicknamePath(source: string): string | null {
  return /["\\]/.test(source) ? null : `$.catalogNicknames."${source}"`;
}

/** `source`'s own cached nickname in the stored identity, while it is still `key`'s; null when it has none. */
function catalogNicknameOf(key: string, source: string): string | null {
  try {
    const p = JSON.parse(readTemplatesAuthorRaw() ?? "null") as { key?: unknown; catalogNicknames?: Record<string, unknown> } | null;
    if (!p || p.key !== key || typeof p.catalogNicknames !== "object" || p.catalogNicknames === null) return null;
    const own = Object.prototype.hasOwnProperty.call(p.catalogNicknames, source) ? p.catalogNicknames[source] : null;
    return typeof own === "string" && own ? own : null;
  } catch {
    return null;
  }
}

/** `a` as `source` sees it: its own nickname there, else the production one. */
function forCatalog(a: TemplatesAuthorSetting | null, source: string | undefined): TemplatesAuthorSetting | null {
  if (!a || isMainNicknameSlot(source)) return a;
  const own = catalogNicknameOf(a.key, nicknameSlot(source));
  return own ? { ...a, nickname: own } : a;
}

function readTemplatesAuthorRaw(row: number = authorRow()): string | null {
  const db = getDb();
  const [found] = db
    .select({ templatesAuthor: settings.templatesAuthor })
    .from(settings)
    .where(eq(settings.id, row))
    .limit(1)
    .all();
  return found?.templatesAuthor ?? null;
}

/**
 * The stored identity, or null when there is none yet (or the stored value is
 * unusable). `source`: the catalog whose nickname to answer (see
 * `isMainNicknameSlot`); omitted, this mode's own (production's; test mode's fixture's).
 */
export function getTemplatesAuthor(source?: string): TemplatesAuthorSetting | null {
  return forCatalog(parseTemplatesAuthor(readTemplatesAuthorRaw()), source);
}

/**
 * Write `next` only while the stored value is still exactly `expectedRaw` — one
 * statement, so no other writer (another request in this process across an
 * await, the MCP child, a second libi on the same LIBI_HOME) can land between
 * the check and the write. Returns whether it wrote.
 */
function compareAndSetTemplatesAuthor(expectedRaw: string | null, next: TemplatesAuthorSetting, row: number = authorRow()): boolean {
  registerLiveSecret(next.key);
  const set = { templatesAuthor: JSON.stringify(next), updatedAt: new Date() };
  const res = keyBoundWrite(() =>
    getDb()
      .insert(settings)
      .values({ id: row, ...set })
      .onConflictDoUpdate({ target: settings.id, set, setWhere: sql`${settings.templatesAuthor} IS ${expectedRaw}` })
      .run(),
  );
  return res.changes > 0;
}

function writeTemplatesAuthor(next: TemplatesAuthorSetting, row: number = authorRow()): void {
  registerLiveSecret(next.key);
  const set = { templatesAuthor: JSON.stringify(next), updatedAt: new Date() };
  keyBoundWrite(() => getDb().insert(settings).values({ id: row, ...set }).onConflictDoUpdate({ target: settings.id, set }).run());
}

/**
 * Persist the identity. Refuses (throws) to replace a DIFFERENT stored key
 * unless `replaceKey` is set — only the import path does that. Anything that
 * read the identity, awaited, and wants to save it back must not resurrect a
 * key imported meanwhile; to change the nickname use setTemplatesAuthorNickname.
 */
export function setTemplatesAuthor(next: TemplatesAuthorSetting, opts: { replaceKey?: boolean } = {}): void {
  if (!CREATOR_KEY_PATTERN.test(next.key)) throw new Error("not a creator key");
  const value: TemplatesAuthorSetting = { ...next, authorId: authorIdFromKey(next.key) };
  // The import path: the user asked for this key, whatever is stored now.
  if (opts.replaceKey) return writeTemplatesAuthor(value);
  const raw = readTemplatesAuthorRaw();
  const cur = parseTemplatesAuthor(raw);
  if (cur && cur.key !== next.key) {
    throw new TemplatesAuthorChangedError("refusing to overwrite a different creator key");
  }
  if (!compareAndSetTemplatesAuthor(raw, value)) {
    throw new TemplatesAuthorChangedError("the creator identity changed while it was being saved");
  }
}

/**
 * One field of the stored identity, NULL when the stored value is not JSON.
 * CASE, not AND: json_extract throws on malformed JSON and AND is not
 * guaranteed to short-circuit.
 */
function authorField(path: string) {
  const col = settings.templatesAuthor;
  return sql`CASE WHEN json_valid(${col}) THEN json_extract(${col}, ${path}) END`;
}

/**
 * Set the nickname, but only while the stored key is still `expectedKey` — a
 * single compare-and-set statement, so a key imported while the caller awaited
 * the site is never overwritten. Returns false (and writes nothing) when the key
 * has changed or there is no identity. On false the nickname belonged to an
 * identity that is gone: re-read before deciding anything, never blindly retry.
 *
 * `expectedNickname` (null included) also holds the write to the nickname the
 * caller read: a cache write-back of the site's value (`/mine`, key import)
 * passes it, so a nickname the user set while the site was answering is never
 * overwritten by the older one the site sent. False then means either changed.
 */
export function setTemplatesAuthorNickname(expectedKey: string, nickname: string | null, opts: { expectedNickname?: string | null; source?: string } = {}): boolean {
  if (!CREATOR_KEY_PATTERN.test(expectedKey)) return false;
  // `source`: the catalog this nickname is that catalog's for — only its own slot is written (see isMainNicknameSlot).
  const main = isMainNicknameSlot(opts.source);
  const path = main ? "$.nickname" : catalogNicknamePath(nicknameSlot(opts.source));
  if (path === null) return false;
  registerLiveSecret(expectedKey);
  const col = settings.templatesAuthor;
  // What the caller read for that catalog: its own nickname, else the production one (`forCatalog`).
  const current = main
    ? authorField("$.nickname")
    : sql`CASE WHEN json_valid(${col}) THEN coalesce(nullif(json_extract(${col}, ${path}), ''), json_extract(${col}, '$.nickname')) END`;
  const res = keyBoundWrite(() =>
    getDb()
      .update(settings)
      .set({ templatesAuthor: sql`json_set(${col}, ${path}, ${nickname})`, updatedAt: new Date() })
      .where(
        and(
          eq(settings.id, authorRow()),
          sql`${authorField("$.key")} = ${expectedKey}`,
          // IS, not =: a stored null must match an expected null.
          opts.expectedNickname === undefined ? undefined : sql`${current} IS ${opts.expectedNickname}`,
        ),
      )
      .run(),
  );
  return res.changes > 0;
}

/**
 * Give `cur` a default nickname (lib/templates/cloud/default-nickname.ts) when
 * it has none — an identity made before defaults existed, or one whose
 * nickname was cleared. One compare-and-set statement: written only while the
 * stored key is still `cur.key` AND its nickname still empty, so a nickname
 * the user (or the site's write-back) set meanwhile is never overwritten, and a
 * key imported meanwhile never receives it. On a lost race the stored identity
 * is answered as it now stands. Throws `TemplatesAuthorWriteError` only.
 */
function backfillTemplatesAuthorNickname(cur: TemplatesAuthorSetting): TemplatesAuthorSetting {
  if (cur.nickname) return cur;
  registerLiveSecret(cur.key);
  const nickname = generateDefaultNickname();
  const col = settings.templatesAuthor;
  const res = keyBoundWrite(() =>
    getDb()
      .update(settings)
      .set({ templatesAuthor: sql`json_set(${col}, '$.nickname', ${nickname})`, updatedAt: new Date() })
      .where(
        and(
          eq(settings.id, authorRow()),
          sql`${authorField("$.key")} = ${cur.key}`,
          // Missing, null, "" and a non-string all read as "no nickname" (parseTemplatesAuthor).
          // CASE, not AND: json_type throws on malformed JSON (see authorField).
          sql`CASE WHEN json_valid(${col}) THEN (json_type(${col}, '$.nickname') IS NOT 'text' OR json_extract(${col}, '$.nickname') = '') ELSE 0 END`,
        ),
      )
      .run(),
  );
  if (res.changes > 0) {
    logger.info({ tag: "templates", op: "author_nickname_defaulted" }, "gave the creator identity a default nickname");
    return { ...cur, nickname };
  }
  return getTemplatesAuthor() ?? cur;
}

/**
 * The identity for display and publishing: as `getTemplatesAuthor`, but an
 * identity with no nickname is given its default first (the lazy backfill).
 * Never creates the identity. A backfill the database refuses is logged and
 * the identity answered without one — a read must not fail on a cache write.
 */
export function getTemplatesAuthorForDisplay(source?: string): TemplatesAuthorSetting | null {
  const cur = getTemplatesAuthor();
  if (!cur || cur.nickname) return forCatalog(cur, source);
  try {
    return forCatalog(backfillTemplatesAuthorNickname(cur), source);
  } catch (err) {
    if (!(err instanceof TemplatesAuthorWriteError)) throw err;
    logger.warn({ tag: "templates", op: "author_nickname_default_failed", sqliteCode: err.sqliteCode }, "could not save a default nickname");
    return forCatalog(cur, source);
  }
}

/**
 * Created on the first VIEW of the nickname or the key (the author and key
 * GET routes — the Templates page and the Settings card), else on the first
 * publish request, publish or nickname edit; stable for the life of the
 * install until the user imports another key (an unused one is replaced
 * without asking: lib/templates/cloud/key-usage.ts). A new
 * identity carries a default nickname from the start; an existing one without
 * a nickname is given one here (`backfillTemplatesAuthorNickname`).
 */
export function getOrCreateTemplatesAuthor(source?: string): TemplatesAuthorSetting {
  return forCatalog(getOrCreateProductionTemplatesAuthor(), source)!;
}

function getOrCreateProductionTemplatesAuthor(): TemplatesAuthorSetting {
  const raw = readTemplatesAuthorRaw();
  const cur = parseTemplatesAuthor(raw);
  if (cur) return backfillTemplatesAuthorNickname(cur);
  if (raw !== null) {
    // Never the value itself: it may hold the user's only copy of their key.
    logger.warn({ tag: "templates", op: "author_unparseable" }, "stored creator identity is unusable; minting a new one");
  }
  const key = generateCreatorKey();
  const next: TemplatesAuthorSetting = { key, authorId: authorIdFromKey(key), nickname: generateDefaultNickname(), createdAt: Date.now() };
  // Guarded on the value just read: if another writer minted first, theirs wins.
  if (compareAndSetTemplatesAuthor(raw, next)) return next;
  const winner = getTemplatesAuthor();
  if (!winner) throw new TemplatesAuthorChangedError("the creator identity changed while it was being created");
  return backfillTemplatesAuthorNickname(winner);
}

/**
 * Both stored identities — the production one and test mode's — read raw for
 * a DB reset to carry across (app/api/db/resolve). Raw on purpose: a reset in
 * test mode must not lose the production key, and an unparseable value may
 * still be the user's only copy of it. Each read is separate, so one broken
 * row does not cost the other.
 */
export interface CarriedTemplatesAuthors {
  production: string | null;
  testMode: string | null;
}

export function readTemplatesAuthorsForReset(): CarriedTemplatesAuthors {
  const read = (row: number) => {
    try {
      return readTemplatesAuthorRaw(row);
    } catch {
      return null;
    }
  };
  const carried = { production: read(PRODUCTION_AUTHOR_ROW), testMode: read(TEST_MODE_AUTHOR_ROW) };
  // Held in memory until the restore: the logger and Sentry mask both keys meanwhile.
  parseTemplatesAuthor(carried.production);
  parseTemplatesAuthor(carried.testMode);
  return carried;
}

/** Put back what `readTemplatesAuthorsForReset` carried, into the fresh DB. Throws `TemplatesAuthorWriteError` only. */
export function restoreTemplatesAuthorsAfterReset(carried: CarriedTemplatesAuthors): void {
  for (const [row, raw] of [[PRODUCTION_AUTHOR_ROW, carried.production], [TEST_MODE_AUTHOR_ROW, carried.testMode]] as const) {
    if (raw === null) continue;
    const set = { templatesAuthor: raw, updatedAt: new Date() };
    keyBoundWrite(() => getDb().insert(settings).values({ id: row, ...set }).onConflictDoUpdate({ target: settings.id, set }).run());
  }
}

/**
 * Paste a key from another machine: same author from now on. It is stored with
 * a fresh default nickname, which the caller replaces with the one the site
 * already shows for this key (compare-and-set against the default, so a
 * nickname the user types meanwhile wins); offline, the default stands until
 * `/mine` learns the site's.
 */
export function importTemplatesAuthorKey(raw: string): TemplatesAuthorSetting {
  const key = raw.trim();
  if (!CREATOR_KEY_PATTERN.test(key)) throw new Error("not a creator key");
  const next: TemplatesAuthorSetting = { key, authorId: authorIdFromKey(key), nickname: generateDefaultNickname(), createdAt: Date.now() };
  setTemplatesAuthor(next, { replaceKey: true });
  return next;
}

// ---------------------------------------------------------------------------
// Templates catalog (dev builds only) — lib/templates/cloud/catalog-setting.ts
//
// Which public templates catalog a DEV build reads, and the development
// site's Vercel protection-bypass token. The token is a secret: registered
// with the live-secret mask whenever it is read or written, never part of
// getSettings() / GET /api/settings, and never answered by any route (the
// catalog-setting route says only whether one is set).
// ---------------------------------------------------------------------------

import { BYPASS_TOKEN_PATTERN, parseDevOrigin } from "@/lib/templates/cloud/catalog-origin";

export type TemplatesCatalogChoice = "production" | "development";

export interface TemplatesCatalogSetting {
  choice: TemplatesCatalogChoice;
  /** The development site's origin (validated by parseDevOrigin), or null for "not set". */
  devOrigin: string | null;
  /** The Vercel bypass secret for `devOrigin` — bound to it: a new origin clears it. */
  bypassToken: string | null;
}

/**
 * A write of the catalog setting failed in the database. Thrown IN PLACE OF
 * the driver's error, never wrapping it: drizzle's message carries the bound
 * params, and the token is one of them.
 */
export class TemplatesCatalogWriteError extends Error {
  readonly sqliteCode: string | null;
  constructor(sqliteCode: string | null) {
    super(`could not save the templates catalog setting${sqliteCode ? ` (${sqliteCode})` : ""}`);
    this.name = "TemplatesCatalogWriteError";
    this.sqliteCode = sqliteCode;
  }
}

/** The stored value, or null when there is none or it is unusable. Anything invalid inside it reads as unset. */
export function parseTemplatesCatalogSetting(raw: string | null): TemplatesCatalogSetting | null {
  if (!raw) return null;
  let p: Partial<Record<keyof TemplatesCatalogSetting, unknown>> | null;
  try {
    p = JSON.parse(raw) as typeof p;
  } catch {
    return null;
  }
  if (!p || typeof p !== "object") return null;
  const choice: TemplatesCatalogChoice = p.choice === "development" ? "development" : "production";
  const origin = typeof p.devOrigin === "string" ? parseDevOrigin(p.devOrigin) : null;
  const devOrigin = origin?.ok ? origin.origin : null;
  const bypassToken = devOrigin && typeof p.bypassToken === "string" && BYPASS_TOKEN_PATTERN.test(p.bypassToken) ? p.bypassToken : null;
  // Whatever this process now holds, the logger and Sentry mask.
  registerLiveSecret(bypassToken);
  return { choice, devOrigin, bypassToken };
}

/**
 * Bumped by every write of the catalog setting in this process, so a memoized
 * read (lib/templates/cloud/catalog-setting.ts) sees the write at once. On
 * globalThis: Next can load this module more than once.
 */
declare global {
  var __libiTemplatesCatalogSettingGeneration: number | undefined;
}
export function templatesCatalogSettingGeneration(): number {
  return globalThis.__libiTemplatesCatalogSettingGeneration ?? 0;
}

export function getTemplatesCatalogSetting(): TemplatesCatalogSetting | null {
  const [found] = getDb().select({ v: settings.templatesCatalog }).from(settings).where(eq(settings.id, 1)).limit(1).all();
  return parseTemplatesCatalogSetting(found?.v ?? null);
}

export function setTemplatesCatalogSetting(next: TemplatesCatalogSetting): void {
  registerLiveSecret(next.bypassToken);
  const set = { templatesCatalog: JSON.stringify(next), updatedAt: new Date() };
  try {
    getDb().insert(settings).values({ id: 1, ...set }).onConflictDoUpdate({ target: settings.id, set }).run();
  } catch (err) {
    throw new TemplatesCatalogWriteError(sqliteCodeOf(err));
  } finally {
    // Even a failed write: the next read goes to the database, never to what was remembered before it.
    globalThis.__libiTemplatesCatalogSettingGeneration = templatesCatalogSettingGeneration() + 1;
  }
}
