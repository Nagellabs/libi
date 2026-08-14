// lib/analytics/page-tracking.ts
// Pure page-path normalization + an engagement timer. The provider wires these
// to usePathname() + visibility listeners; the logic stays dependency-free.

const DYNAMIC_RULES: { re: RegExp; template: string }[] = [
  { re: /^\/characters\/[^/]+$/, template: "/characters/[id]" },
  { re: /^\/items\/[^/]+$/, template: "/items/[id]" },
  { re: /^\/mcps-skills\/skills\/[^/]+$/, template: "/mcps-skills/skills/[name]" },
];

/** Collapse dynamic id/name segments so page_path stays low-cardinality. */
export function normalizePagePath(pathname: string): string {
  for (const { re, template } of DYNAMIC_RULES) {
    if (re.test(pathname)) return template;
  }
  return pathname;
}

export interface EngagementTimer {
  enter(path: string, nowMs: number): void;
  leave(nowMs: number): { page_path: string; engagement_msec: number } | null;
}

export function makeEngagementTimer(): EngagementTimer {
  let current: { path: string; at: number } | null = null;
  return {
    enter(path, nowMs) {
      current = { path, at: nowMs };
    },
    leave(nowMs) {
      if (!current) return null;
      const out = { page_path: current.path, engagement_msec: Math.max(0, nowMs - current.at) };
      current = null;
      return out;
    },
  };
}
