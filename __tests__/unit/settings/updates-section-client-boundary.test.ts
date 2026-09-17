/**
 * The update card is a CLIENT component, so everything it imports is bundled
 * for the browser — transitively.
 *
 * On 2026-09-18 it imported `compareVersions` from `@/lib/runtime/update-check`,
 * which imports `runtime-install.ts` → `node-runtime.ts` → `lib/db/native-binding.ts`.
 * Next answered the whole Settings page with a 500 (`module-not-found`: the
 * native better-sqlite3 binding cannot be bundled for the browser). Every unit
 * test still passed — vitest resolves those modules in node, so the failure was
 * invisible until the page was actually loaded.
 *
 * This walks the real `@/`-import graph from the card and fails if it reaches
 * anything server-only. It is a static source read: no bundler, no rendering.
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(__dirname, "../../..");

/** Modules that cannot exist in a browser bundle, and why. */
const SERVER_ONLY: Record<string, string> = {
  "lib/db/native-binding": "loads the native better-sqlite3 binding",
  "lib/db/client": "opens the SQLite database",
  "lib/runtime/runtime-install": "spawns npm and writes to disk",
  "lib/runtime/node-runtime": "resolves and execs a node binary",
  "lib/jobs/manager": "owns the server-side job runners",
};

function resolveAlias(spec: string): string | null {
  if (!spec.startsWith("@/")) return null;
  const rel = spec.slice(2);
  for (const candidate of [
    `${rel}.ts`,
    `${rel}.tsx`,
    path.join(rel, "index.ts"),
    path.join(rel, "index.tsx"),
  ]) {
    const abs = path.join(repoRoot, candidate);
    if (fs.existsSync(abs)) return candidate;
  }
  return null;
}

/** Every `@/...` specifier in a file, type-only imports excluded — those are
 *  erased at compile time and pull nothing into the bundle. */
function aliasImports(file: string): string[] {
  const src = fs.readFileSync(path.join(repoRoot, file), "utf-8");
  const out: string[] = [];
  const re = /(?:^|\n)\s*import\s+([\s\S]*?)from\s+["'](@\/[^"']+)["']/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    const clause = m[1];
    if (/^\s*type\s/.test(clause)) continue; // `import type { X } from …`
    out.push(m[2]);
  }
  return out;
}

/** BFS the alias-import graph, returning the first path that reaches a
 *  server-only module, or null. */
function findServerOnlyPath(entry: string): string[] | null {
  const seen = new Set<string>([entry]);
  const queue: string[][] = [[entry]];
  while (queue.length > 0) {
    const trail = queue.shift()!;
    const file = trail[trail.length - 1];
    for (const spec of aliasImports(file)) {
      const resolved = resolveAlias(spec);
      if (!resolved) continue;
      const key = resolved.replace(/\.tsx?$/, "");
      if (key in SERVER_ONLY) return [...trail, resolved];
      if (seen.has(resolved)) continue;
      seen.add(resolved);
      queue.push([...trail, resolved]);
    }
  }
  return null;
}

describe("the update card's client bundle", () => {
  it("never reaches a server-only module", () => {
    const trail = findServerOnlyPath("components/settings/updates-section.tsx");
    expect(
      trail,
      trail
        ? `server-only import reached via:\n  ${trail.join("\n  → ")}\n` +
            `(${SERVER_ONLY[trail[trail.length - 1].replace(/\.tsx?$/, "")]})`
        : "",
    ).toBeNull();
  });

  it("and neither does the query hook every update surface shares", () => {
    const trail = findServerOnlyPath("lib/queries/runtime-update.ts");
    expect(trail, trail ? `reached via:\n  ${trail.join("\n  → ")}` : "").toBeNull();
  });

  it("keeps the version comparator a leaf — that is the whole reason it exists", () => {
    // If this file ever grows an import, the 500 above can come back through it.
    expect(aliasImports("lib/runtime/version-compare.ts")).toEqual([]);
  });
});
