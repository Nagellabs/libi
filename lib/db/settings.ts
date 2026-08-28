import { eq } from "drizzle-orm";
import { getDb } from "./client";
import { settings } from "./schema";
import { serverLogger } from "@/lib/logger";
import {
  type AnalyticsSettings,
  parseAnalyticsSettings,
  mergeAnalyticsSettings,
  markMilestone,
} from "@/lib/analytics/settings-logic";
import { crashReportChoiceAllowsReporting } from "@/lib/sentry/enabled";

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
// Codex connect setting (typed helpers over the settings.codex JSON column)
// ---------------------------------------------------------------------------

export type CodexConnectSetting = {
  /** Whether the user opted in to keep their global ~/.codex MCP entries in sync with libi. */
  connected: boolean;
  /** Outcome of the last sync attempt. */
  lastSyncStatus: "ok" | "error" | "idle";
};

const CODEX_CONNECT_DEFAULTS: CodexConnectSetting = {
  connected: false,
  lastSyncStatus: "idle",
};

/**
 * Read the codex connect setting. Returns defaults if the row is missing,
 * the column is null/empty, the stored JSON is malformed / wrong-shape, or
 * the DB read itself fails (e.g. a pending migration) — this is a defensive
 * read that must never throw.
 */
export function getCodexConnectSetting(): CodexConnectSetting {
  try {
    const db = getDb();
    const [row] = db
      .select({ codex: settings.codex })
      .from(settings)
      .where(eq(settings.id, 1))
      .limit(1)
      .all();

    const raw = row?.codex;
    if (!raw) return { ...CODEX_CONNECT_DEFAULTS };

    const parsed = JSON.parse(raw) as Partial<CodexConnectSetting> | null;
    if (!parsed || typeof parsed !== "object") return { ...CODEX_CONNECT_DEFAULTS };
    if (typeof parsed.connected !== "boolean") return { ...CODEX_CONNECT_DEFAULTS };
    const status = parsed.lastSyncStatus;
    if (status !== "ok" && status !== "error" && status !== "idle") {
      return { ...CODEX_CONNECT_DEFAULTS };
    }
    return { connected: parsed.connected, lastSyncStatus: status };
  } catch (err) {
    serverLogger.warn(
      { err, tag: "codex-connect", op: "read_degraded" },
      "getCodexConnectSetting: read failed, returning defaults",
    );
    return { ...CODEX_CONNECT_DEFAULTS };
  }
}

/**
 * Persist the codex connect setting as a JSON string in the settings table.
 * Upserts the single-row settings record if it doesn't already exist.
 */
export function setCodexConnectSetting(s: CodexConnectSetting): void {
  const db = getDb();
  const value = JSON.stringify(s);
  const set = { codex: value, updatedAt: new Date() };

  db.insert(settings)
    .values({ id: 1, ...set })
    .onConflictDoUpdate({ target: settings.id, set })
    .run();
}

// ---------------------------------------------------------------------------
// Export defaults setting (folder + default format + default quality)
// ---------------------------------------------------------------------------

import { defaultExportFolder } from "@/lib/export/folder";

export type ExportDefaultsSetting = {
  /** Absolute path. Null = use OS-aware default (~/Movies/libi on darwin, ~/Videos/libi elsewhere). */
  folder: string | null;
  format: "mp4" | "webm";
  quality: "source" | "1080p" | "1440p" | "4k";
};

const EXPORT_DEFAULTS_FALLBACK: ExportDefaultsSetting = {
  folder: null,
  format: "mp4",
  quality: "source",
};

/** Read the export defaults. Falls back to OS-aware folder + MP4/Source if
 *  the row is missing, the column is empty, or the JSON is malformed. */
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
      folder: typeof parsed.folder === "string" && parsed.folder ? parsed.folder : null,
      format: parsed.format === "webm" ? "webm" : "mp4",
      quality:
        parsed.quality === "1080p" || parsed.quality === "1440p" || parsed.quality === "4k"
          ? parsed.quality
          : "source",
    };
  } catch {
    return { ...EXPORT_DEFAULTS_FALLBACK };
  }
}

/** Resolve the effective export folder — settings if set, otherwise OS default. */
export function resolveExportFolder(): string {
  const defaults = getExportDefaults();
  return defaults.folder ?? defaultExportFolder();
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
