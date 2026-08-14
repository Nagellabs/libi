import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The onboarding must never be gated behind library state.
 *
 * The editor page renders `<PersonaModal />` and (via EditorLayout's
 * `rightTakeover`) the connect-an-agent panel in its MAIN return. Every
 * `return` above that is an early exit — and an early exit that forgets the
 * modal hides the onboarding from whoever hits that branch.
 *
 * That is not hypothetical. A `piecesScreen === "welcome"` early return sat
 * above them, so the ONLY user who never saw the persona question, the
 * connect-an-agent screen, or the "I'll build you a short example video" chip
 * was the brand-new user all three exist for; onboarding appeared *after* you
 * created your first piece. This is a source scan rather than a render test
 * because the failure is structural — where a `return` sits, not what it
 * paints — and rendering this page means standing up a dozen providers.
 *
 * Early returns are indented 4 spaces (they live inside an `if`); the main
 * return is at 2. That indentation is the discriminator.
 */

const PAGE = join(process.cwd(), "app/(app)/editor/page.tsx");

/** Every early-return JSX block in the page component, as source text. */
function earlyReturnBlocks(source: string): string[] {
  const blocks: string[] = [];
  const lines = source.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (lines[i] !== "    return (") continue;
    const body: string[] = [];
    for (let j = i + 1; j < lines.length; j++) {
      if (lines[j] === "    );") break;
      body.push(lines[j]);
    }
    blocks.push(body.join("\n"));
  }
  return blocks;
}

describe("editor page — onboarding is reachable from every screen", () => {
  const source = readFileSync(PAGE, "utf8");

  it("finds the early returns it is meant to be checking", () => {
    // Guards the guard: if the page is restructured so this scan matches
    // nothing, the test must fail loudly rather than pass vacuously.
    expect(earlyReturnBlocks(source).length).toBeGreaterThan(0);
  });

  it("renders the persona modal in every early return", () => {
    for (const block of earlyReturnBlocks(source)) {
      const firstLine = block.trim().split("\n")[0];
      expect(block, `early return starting "${firstLine}" is missing <PersonaModal />`)
        .toContain("<PersonaModal />");
    }
  });

  it("has NO early return for the empty library — first run renders inside the layout", () => {
    // The zero-piece screen must stay in EditorLayout, where the chat panel
    // (and therefore the demo offer) lives. `firstRun` on NoPieceEmptyState is
    // how that screen gets its welcome copy.
    expect(source).not.toContain('if (piecesScreen === "welcome") {');
    expect(source).toContain('firstRun={piecesScreen === "welcome"}');
  });

  it("still renders the persona modal and the connect-agent takeover in the main return", () => {
    expect(source).toContain("<PersonaModal />");
    expect(source).toContain("<OnboardingPanel />");
    expect(source).toContain("rightTakeover={rightTakeover}");
  });
});
