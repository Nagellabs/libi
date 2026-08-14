/**
 * Resolve a Finder-style copy name: "<base> (copy)", "(copy 2)", "(copy 3)"…
 * Returns the first variant not present in `existing`.
 */
export function resolveCopyName(baseName: string, existing: string[]): string {
  const taken = new Set(existing);
  const first = `${baseName} (copy)`;
  if (!taken.has(first)) return first;
  for (let n = 2; ; n++) {
    const candidate = `${baseName} (copy ${n})`;
    if (!taken.has(candidate)) return candidate;
  }
}
