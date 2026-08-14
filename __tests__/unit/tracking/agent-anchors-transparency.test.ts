import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import * as path from "node:path";

const ROOT = path.resolve(__dirname, "../../..");

function walk(dir: string, acc: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = path.join(dir, e);
    if (e === "node_modules" || e === ".next" || e.startsWith(".")) continue;
    if (statSync(p).isDirectory()) walk(p, acc);
    else if (/\.(ts|tsx)$/.test(p)) acc.push(p);
  }
  return acc;
}
function stripComments(s: string): string {
  return s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

describe("agentAnchors is transparent — no UI surface reads it", () => {
  for (const sub of ["components", "app", "hooks"]) {
    it(`${sub}/ never references agentAnchors`, () => {
      const offenders = walk(path.join(ROOT, sub))
        // Server API routes (app/api/**) are NOT a UI surface — they are
        // server-only and never rendered to or editable by the user. The
        // read-only verify-render route reads agentAnchors solely to render
        // the agent's faithful verify; that is not user-visible/removable, so
        // it does not break the transparency guarantee (which is about
        // components/hooks/pages the user can see and edit).
        .filter((f) => !path.relative(ROOT, f).startsWith(path.join("app", "api") + path.sep))
        .filter((f) => stripComments(readFileSync(f, "utf8")).includes("agentAnchors"))
        .map((f) => path.relative(ROOT, f));
      expect(offenders, `UI must not read agentAnchors: ${offenders.join(", ")}`).toEqual([]);
    });
  }
});
