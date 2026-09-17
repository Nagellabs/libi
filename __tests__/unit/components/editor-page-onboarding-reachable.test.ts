import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * A first launch lands on the Agents tab with the persona question over it.
 *
 * It used to land on the editor: the persona question was mounted there, and a
 * pick pushed the user to `/agents` — so the editor painted and then switched
 * away, which read as a glitch. Now the editor page's default export is a gate
 * that paints nothing of the editor until the onboarding state is known, and
 * sends a first launch to `/agents` before any editor screen renders; the
 * question itself lives on the Agents route. The gate's behaviour is rendered in
 * first-launch-gate.test.tsx; this file pins where things sit, which a render
 * test cannot see without standing up the dozen providers this page needs.
 *
 * The empty-library pin predates this: a `piecesScreen === "welcome"` early
 * return once swallowed the first-run onboarding for exactly the brand-new user
 * it was written for.
 */

const PAGE = join(process.cwd(), "app/(app)/editor/page.tsx");
const AGENTS_ROUTE = join(process.cwd(), "app/(app)/agents/page.tsx");

/** The source of the page's default export, up to its closing brace. */
function defaultExportBody(source: string): string {
  const start = source.indexOf("export default function EditorPage()");
  expect(start, "the page's default export moved or was renamed").toBeGreaterThanOrEqual(0);
  const rest = source.slice(start);
  return rest.slice(0, rest.indexOf("\n}\n"));
}

describe("editor page — a first launch lands on the Agents tab", () => {
  const source = readFileSync(PAGE, "utf8");
  const agentsRoute = readFileSync(AGENTS_ROUTE, "utf8");

  it("the default export renders every editor screen behind the first-launch gate, with only the loading screen before it", () => {
    const body = defaultExportBody(source);
    expect(body).toContain("<FirstLaunchGate fallback={<EditorLoadingScreen />}>");
    expect(body).toContain("<EditorWorkspace />");
    // Nothing runs ahead of the gate: no hook, so no editor effect fires for a first launch.
    expect(body).not.toMatch(/\buse[A-Z]\w*\(/);
  });

  it("the persona question is asked on the Agents route, not by any editor screen", () => {
    expect(source).not.toContain("PersonaModal");
    expect(agentsRoute).toContain("<PersonaModal />");
  });

  it("has NO early return for the empty library — first run renders inside the layout", () => {
    // The zero-piece screen must stay in EditorLayout, where the chat panel
    // (and therefore the demo offer) lives. `firstRun` on NoPieceEmptyState is
    // how that screen gets its welcome copy.
    expect(source).not.toContain('if (piecesScreen === "welcome") {');
    expect(source).toContain('firstRun={piecesScreen === "welcome"}');
  });

  it("renders no takeover", () => {
    expect(source).not.toContain("rightTakeover");
  });
});
