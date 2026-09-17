/**
 * Audit fal endpoint IDs referenced in bundled skills against fake-fal's KB.
 *
 *   npm run skill:eval:audit
 *
 * Prints three groups: in-KB, unknown-to-KB (the live-fal verification
 * punch-list), and KB-only (entries no skill references). Also exported as a
 * pure function for the KB-coverage drift test.
 */
import { readdirSync, readFileSync, lstatSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { MODEL_KB, resolveEndpoint } from "@/mcp/dev/fake-fal/kb";

/** Vendor prefixes that begin a fal endpoint id. Keep in sync with MODEL_KB: a vendor
 *  missing here used to be a SILENT blind spot — skills referencing it were never
 *  audited, so a phantom endpoint read as "covered". `decart` was exactly that
 *  (ugc-product-video's Route B default `decart/lucy-restyle`). The blind spot is now
 *  LOUD instead: `unclassifiedEndpointPrefixes()` fails the coverage test on any new
 *  `<prefix>/<path>` token that is neither a vendor here nor a known non-vendor path. */
export const ENDPOINT_VENDORS = [
  "fal-ai",
  "openai",
  "bytedance",
  "bria",
  "veed",
  "decart",
] as const;

/** Backtick'd `<vendor>/…` token regex — matches the spec's grep. */
const ENDPOINT_RE = new RegExp(
  `\`((?:${ENDPOINT_VENDORS.join("|")})/[a-zA-Z0-9/_.-]+)\``,
  "g",
);

/** Any backtick'd `a/b…` token, whatever the first segment is. */
const ANY_SLASH_TOKEN_RE = /`([a-zA-Z0-9][a-zA-Z0-9_.-]*)\/[a-zA-Z0-9/_.-]+`/g;

/** First segments that are legitimately NOT vendors: repo/skill paths, doc links, and
 *  endpoint-id FRAGMENTS quoted mid-sentence without their vendor prefix. Anything that
 *  is neither here nor in ENDPOINT_VENDORS is unclassified — add it to one list or the
 *  other (and to MODEL_KB, if it is a real vendor). */
const NON_VENDOR_PREFIXES = new Set([
  // repo + skill-relative paths
  "references",
  "prompts",
  "templates",
  "lib",
  "mcp",
  "app",
  "components",
  "hooks",
  "scripts",
  "electron",
  "drizzle",
  "e2e",
  "skill-eval",
  "__tests__",
  "docs-local",
  "snapshots",
  // endpoint-id fragments quoted without the vendor prefix
  "veo3.1",
  "o1",
  "fast",
  // not a path and not an id
  "easeIn",
]);

function walkMd(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const stat = lstatSync(p);
    if (stat.isSymbolicLink()) continue; // skip symlinks: avoids broken-link crashes + cycles
    if (stat.isDirectory()) out.push(...walkMd(p));
    else if (name.endsWith(".md")) out.push(p);
  }
  return out;
}

/** All distinct backtick'd endpoint IDs referenced across skill .md files. */
export function extractSkillEndpoints(skillsDir: string): string[] {
  const set = new Set<string>();
  for (const file of walkMd(skillsDir)) {
    const text = readFileSync(file, "utf8");
    for (const m of text.matchAll(ENDPOINT_RE)) set.add(m[1]);
  }
  return [...set].sort();
}

/** One backtick'd `a/b` token whose first segment is classified neither as a vendor nor
 *  as a known non-vendor path — carrying WHERE it was found, which is the whole point. */
export interface UnclassifiedPrefix {
  /** The unclassified first segment, e.g. `luma`. */
  prefix: string;
  /** The whole backtick'd token as written, e.g. `luma/ray-3`. */
  token: string;
  /** Path of the .md file it appears in, relative to `skillsDir`. */
  file: string;
}

/** Every unclassified `a/b` occurrence, first sighting per (prefix, token, file). */
export function unclassifiedEndpointOccurrences(skillsDir: string): UnclassifiedPrefix[] {
  const seen = new Set<string>();
  const out: UnclassifiedPrefix[] = [];
  for (const file of walkMd(skillsDir)) {
    const text = readFileSync(file, "utf8");
    const rel = relative(skillsDir, file);
    for (const m of text.matchAll(ANY_SLASH_TOKEN_RE)) {
      const prefix = m[1];
      if ((ENDPOINT_VENDORS as readonly string[]).includes(prefix)) continue;
      if (NON_VENDOR_PREFIXES.has(prefix)) continue;
      const token = m[0].replace(/`/g, "");
      const key = `${prefix}\u0000${token}\u0000${rel}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ prefix, token, file: rel });
    }
  }
  return out.sort((a, b) => (a.prefix + a.token + a.file).localeCompare(b.prefix + b.token + b.file));
}

/** First segments of backtick'd `a/b` tokens in skill .md files that are classified
 *  neither as a vendor nor as a known non-vendor path. A non-empty result means the
 *  audit (and therefore the KB-coverage guard) may be silently skipping an endpoint. */
export function unclassifiedEndpointPrefixes(skillsDir: string): string[] {
  return [...new Set(unclassifiedEndpointOccurrences(skillsDir).map((u) => u.prefix))].sort();
}

/**
 * The failure text for an unclassified prefix. `unclassifiedEndpointPrefixes()` is
 * correct and stays — the defect was that an UNRELATED change (a repo directory quoted as
 * `foo/bar` inside a skill) failed a skill-eval test with a message that named neither the
 * offending file nor what to do about it. This says both, per occurrence.
 */
export function describeUnclassified(found: readonly UnclassifiedPrefix[]): string {
  if (found.length === 0) return "";
  const lines = found.map((u) => `  - \`${u.token}\`  (prefix \`${u.prefix}\`)  in mcp/skills/${u.file}`);
  return (
    `${found.length} backtick'd \`a/b\` token(s) in mcp/skills have a first segment that is ` +
    "neither a known fal vendor nor a known non-vendor path, so the endpoint audit cannot " +
    "tell an unaudited model id from a repo path and skips them:\n" +
    `${lines.join("\n")}\n` +
    "Classify each one in scripts/skill-eval/audit-endpoints.ts:\n" +
    "  • it is a real provider vendor → add the prefix to ENDPOINT_VENDORS, and add the " +
    "endpoint to MODEL_KB (mcp/dev/fake-fal/kb.ts) so test-mode can serve it;\n" +
    "  • it is a repo/skill path, a doc link, or an endpoint-id fragment quoted without " +
    "its vendor → add the prefix to NON_VENDOR_PREFIXES;\n" +
    "  • it is neither → stop quoting it as `a/b` in the skill."
  );
}

function main(): void {
  const skillsDir = resolve(process.cwd(), "mcp", "skills");
  const referenced = extractSkillEndpoints(skillsDir);

  const inKb: string[] = [];
  const unknown: string[] = [];
  for (const id of referenced) {
    (resolveEndpoint(id, null).canonical ? inKb : unknown).push(id);
  }
  const kbKeys = Object.keys(MODEL_KB).sort();
  const referencedCanonical = new Set(
    referenced.map((id) => resolveEndpoint(id, null).canonical).filter(Boolean),
  );
  const kbOnly = kbKeys.filter((k) => !referencedCanonical.has(k));

  const fmt = (xs: string[]) => (xs.length ? xs.map((x) => `  - ${x}`).join("\n") : "  (none)");
  console.log("# Fake-fal endpoint audit\n");
  console.log(`## In KB (${inKb.length})\n${fmt(inKb)}\n`);
  console.log(`## UNKNOWN to KB — verify against live fal (${unknown.length})\n${fmt(unknown)}\n`);
  console.log(`## KB-only — no skill references (${kbOnly.length})\n${fmt(kbOnly)}\n`);
  const unclassified = unclassifiedEndpointOccurrences(skillsDir);
  const prefixes = [...new Set(unclassified.map((u) => u.prefix))].sort();
  console.log(
    `## UNCLASSIFIED prefixes — neither a vendor nor a known path (${prefixes.length})\n${fmt(prefixes)}\n`,
  );
  // The count alone sent whoever tripped this hunting. Print the file and the token.
  if (unclassified.length) console.log(`${describeUnclassified(unclassified)}\n`);
}

// Run only when invoked directly (tsx), not when imported by the test.
if (process.argv[1] && process.argv[1].endsWith("audit-endpoints.ts")) main();
