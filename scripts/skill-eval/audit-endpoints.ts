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
import { join, resolve } from "node:path";
import { MODEL_KB, resolveEndpoint } from "@/mcp/dev/fake-fal/kb";

/** Backtick'd `(fal-ai|openai|bytedance|bria|veed)/…` token regex — matches the spec's grep.
 *  Keep this vendor list in sync with MODEL_KB: a vendor missing here is a
 *  SILENT blind spot — skills referencing it are never audited, so a phantom
 *  endpoint would read as "covered". */
const ENDPOINT_RE = /`((?:fal-ai|openai|bytedance|bria|veed)\/[a-zA-Z0-9/_.-]+)`/g;

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
}

// Run only when invoked directly (tsx), not when imported by the test.
if (process.argv[1] && process.argv[1].endsWith("audit-endpoints.ts")) main();
