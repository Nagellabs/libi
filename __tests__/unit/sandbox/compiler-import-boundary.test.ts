/**
 * The body compiler never ships to the app origin (final security review, M5).
 *
 * Bodies compile only inside the sandbox worker (AGENTS.md "Overlay sandbox").
 * Nothing on a host path CALLS the compiler today, but the preview hooks used
 * to import the renderer pool from `lib/engine/three-overlay`, which imports
 * `compileThreeBody`: one line away from running three bodies in the studio's
 * origin again. This walks the static and dynamic imports reachable from every
 * page, component and hook, and from the export's render entry, and fails if
 * either module that can compile a body is among them.
 *
 * Type-only imports are erased and do not count. The walk reads source text,
 * so it resolves `@/` and relative specifiers the way the repo writes them;
 * a package import is a leaf.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const FORBIDDEN = ["lib/sandbox/runtime/compile.ts", "lib/engine/three-overlay.ts"];
const ROOT_DIRS = ["app", "components", "hooks"];
const ROOT_FILES = ["lib/export/render-entry.ts"];

function sourcesUnder(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "node_modules") sourcesUnder(rel, out);
    } else if (/\.(ts|tsx)$/.test(entry.name)) out.push(rel);
  }
  return out;
}

function resolveSpecifier(from: string, spec: string): string | null {
  let base: string;
  if (spec.startsWith("@/")) base = spec.slice(2);
  else if (spec.startsWith(".")) base = path.join(path.dirname(from), spec);
  else return null;
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`]) {
    const abs = path.join(ROOT, candidate);
    if (fs.existsSync(abs) && fs.statSync(abs).isFile()) return path.normalize(candidate);
  }
  return null;
}

/** Specifiers a module loads at runtime: value imports and re-exports,
 *  side-effect imports, and dynamic `import()`. */
function runtimeImports(file: string): string[] {
  const src = fs
    .readFileSync(path.join(ROOT, file), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
  const specs: string[] = [];
  for (const m of src.matchAll(/(?:^|\n)\s*(?:import|export)\s+(type\s+)?[^;]*?from\s+["']([^"']+)["']/g)) {
    if (!m[1]) specs.push(m[2]!);
  }
  for (const m of src.matchAll(/(?:^|\n)\s*import\s+["']([^"']+)["']/g)) specs.push(m[1]!);
  for (const m of src.matchAll(/import\(\s*["']([^"']+)["']\s*\)/g)) specs.push(m[1]!);
  return specs;
}

describe("the body compiler's import boundary (final review M5)", () => {
  it("no page, component, hook or the export's render entry can reach a module that compiles a body", () => {
    const roots = [...ROOT_DIRS.flatMap((d) => sourcesUnder(d)), ...ROOT_FILES];
    const via = new Map<string, string | null>();
    const queue: Array<[string, string | null]> = roots.map((r) => [r, null]);
    while (queue.length) {
      const [file, parent] = queue.shift()!;
      if (via.has(file)) continue;
      via.set(file, parent);
      for (const spec of runtimeImports(file)) {
        const next = resolveSpecifier(file, spec);
        if (next && !via.has(next)) queue.push([next, file]);
      }
    }
    const chains = FORBIDDEN.filter((f) => via.has(f)).map((f) => {
      const chain = [f];
      for (let at = via.get(f); at; at = via.get(at)) chain.unshift(at);
      return chain.join(" -> ");
    });
    expect(chains).toEqual([]);
    // The walk is live: it does see the three pool's compiler-free leaf.
    expect(via.has("lib/engine/three-renderer.ts")).toBe(true);
  });
});

/**
 * Custom effect bodies (fix round 1 on the human-publish review, C1): an
 * `animate.js` is agent- or package-written code and runs ONLY in the effect
 * sandbox's worker. No page, component or hook — nor the export's render entry
 * — may reach the module that samples a body (`runtime/effect-curve.ts`) or
 * the server-side validator that parses one (`lib/effects/compile-custom.ts`).
 * `app/api` is the server and is left out of this walk.
 */
describe("the custom effect body's import boundary", () => {
  it("no page, component, hook or the render entry can reach a module that compiles or runs an effect body", () => {
    const EFFECT_FORBIDDEN = ["lib/sandbox/runtime/effect-curve.ts", "lib/effects/compile-custom.ts"];
    const pageRoots = [
      ...sourcesUnder("app").filter((f) => !f.startsWith(path.join("app", "api"))),
      ...sourcesUnder("components"),
      ...sourcesUnder("hooks"),
      "lib/export/render-entry.ts",
    ];
    const via = new Map<string, string | null>();
    const queue: Array<[string, string | null]> = pageRoots.map((r) => [r, null]);
    while (queue.length) {
      const [file, parent] = queue.shift()!;
      if (via.has(file)) continue;
      via.set(file, parent);
      for (const spec of runtimeImports(file)) {
        const next = resolveSpecifier(file, spec);
        if (next && !via.has(next)) queue.push([next, file]);
      }
    }
    const chains = EFFECT_FORBIDDEN.filter((f) => via.has(f)).map((f) => {
      const chain = [f];
      for (let at = via.get(f); at; at = via.get(at)) chain.unshift(at);
      return chain.join(" -> ");
    });
    expect(chains).toEqual([]);
    // Live: the walk does reach the curve-backed defs and the sampler host.
    expect(via.has("lib/effects/custom-curves.ts")).toBe(true);
    expect(via.has("lib/sandbox/effect-sampler.ts")).toBe(true);
  });
});
