// lib/analytics/settings-logic.ts
// Pure, dependency-free transforms over the analytics settings object. The DB
// wrappers in lib/db/settings.ts call these; keeping them pure makes them
// trivially unit-testable without a database.

export interface AnalyticsSettings {
  /** Master opt-out toggle. Default true (analytics on by default). */
  enabled: boolean;
  /** Per-install UUID used as GA4 client_id + user_id. Generated server-side. */
  userId: string | null;
  /** Epoch ms when the user last opted out (null if never). */
  optOutAt: number | null;
  /** Whether the one-time first-run privacy notice has been shown. */
  firstRunNoticeShown: boolean;
  /** Activation milestones already fired (e.g. "launch", "piece", "export"). */
  milestones: string[];
}

export const DEFAULT_ANALYTICS_SETTINGS: AnalyticsSettings = {
  enabled: true,
  userId: null,
  optOutAt: null,
  firstRunNoticeShown: false,
  milestones: [],
};

export function parseAnalyticsSettings(raw: string | null | undefined): AnalyticsSettings {
  if (!raw) return { ...DEFAULT_ANALYTICS_SETTINGS };
  try {
    const p = JSON.parse(raw) as Partial<AnalyticsSettings> | null;
    if (!p || typeof p !== "object") return { ...DEFAULT_ANALYTICS_SETTINGS };
    return {
      enabled: typeof p.enabled === "boolean" ? p.enabled : true,
      userId: typeof p.userId === "string" ? p.userId : null,
      optOutAt: typeof p.optOutAt === "number" ? p.optOutAt : null,
      firstRunNoticeShown: p.firstRunNoticeShown === true,
      milestones: Array.isArray(p.milestones)
        ? p.milestones.filter((m): m is string => typeof m === "string")
        : [],
    };
  } catch {
    return { ...DEFAULT_ANALYTICS_SETTINGS };
  }
}

export function mergeAnalyticsSettings(
  cur: AnalyticsSettings,
  partial: Partial<AnalyticsSettings>,
): AnalyticsSettings {
  return { ...cur, ...partial };
}

export function markMilestone(
  cur: AnalyticsSettings,
  name: string,
): { settings: AnalyticsSettings; added: boolean } {
  if (cur.milestones.includes(name)) return { settings: cur, added: false };
  return { settings: { ...cur, milestones: [...cur.milestones, name] }, added: true };
}

export function applyOptOut(cur: AnalyticsSettings, nowMs: number): AnalyticsSettings {
  return { ...cur, enabled: false, optOutAt: nowMs };
}

export function applyOptIn(cur: AnalyticsSettings): AnalyticsSettings {
  return { ...cur, enabled: true, optOutAt: null };
}
