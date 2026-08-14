import { getBundledSkillDigests } from "./digest";

export type ForkStaleness = boolean | "unknown";

export interface OverrideStatus {
  overridesBundled: true;
  /** true = bundled content changed since the fork; false = identical;
   *  "unknown" = override predates digest stamping or bundled files missing. */
  bundledUpdatedSinceFork: ForkStaleness;
}

interface RowLike {
  name: string;
  source: "bundled" | "user";
  forkedFromDigest: string | null;
}

/**
 * For every user row that shadows a bundled skill of the same name, derive
 * whether the bundled original has changed since the override was created.
 * Pure given the rows + the current bundled digests; nothing is stored.
 */
export function computeOverrideStatus(rows: RowLike[]): Map<string, OverrideStatus> {
  const bundledNames = new Set(rows.filter((r) => r.source === "bundled").map((r) => r.name));
  const overrides = rows.filter((r) => r.source === "user" && bundledNames.has(r.name));
  const out = new Map<string, OverrideStatus>();
  if (overrides.length === 0) return out;

  const digests = getBundledSkillDigests();
  for (const row of overrides) {
    const current = digests[row.name];
    const staleness: ForkStaleness =
      row.forkedFromDigest && current ? row.forkedFromDigest !== current : "unknown";
    out.set(row.name, { overridesBundled: true, bundledUpdatedSinceFork: staleness });
  }
  return out;
}
