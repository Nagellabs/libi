// lib/runtime/version-compare.ts
//
// Version comparison, as a LEAF module: pure functions, zero imports.
//
// These used to live in `lib/runtime/update-check.ts`, which is the right home
// for the update CHECK but the wrong one for a comparator, because that file
// imports `runtime-install.ts` → `node-runtime.ts` → `lib/db/native-binding.ts`.
// A client component that wanted only `compareVersions` therefore pulled the
// native better-sqlite3 binding into the browser bundle, and Next answered the
// whole Settings page with a 500 (`module-not-found`, 2026-09-18). Unit tests
// could not see it: vitest resolves those modules in node.
//
// So anything importable from BOTH sides of the wire belongs here. Keep this
// file dependency-free — that property is the entire point of it.

/**
 * Compare two dotted versions. Returns <0, 0, >0 like a comparator.
 *
 * Deliberately minimal — libi publishes plain `x.y.z` — with one rule beyond
 * numeric comparison: a prerelease suffix (`1.2.0-rc.1`) sorts BELOW the
 * release it precedes, matching semver, so an rc can never present itself as
 * an upgrade over the release of the same triple.
 */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string): { nums: number[]; pre: string | null } => {
    const [core, ...rest] = v.trim().split("-");
    const nums = core.split(".").map((s) => {
      const n = Number.parseInt(s, 10);
      return Number.isFinite(n) ? n : 0;
    });
    while (nums.length < 3) nums.push(0);
    return { nums, pre: rest.length > 0 ? rest.join("-") : null };
  };
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < Math.max(pa.nums.length, pb.nums.length); i += 1) {
    const d = (pa.nums[i] ?? 0) - (pb.nums[i] ?? 0);
    if (d !== 0) return d;
  }
  if (pa.pre === pb.pre) return 0;
  if (pa.pre === null) return 1; // release > prerelease
  if (pb.pre === null) return -1;
  return pa.pre < pb.pre ? -1 : 1;
}

/** True when `latest` is strictly newer than `current`. */
export function isNewer(latest: string, current: string): boolean {
  return compareVersions(latest, current) > 0;
}
