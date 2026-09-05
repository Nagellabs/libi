import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Files dropped onto a specific piece row in the Resources panel MUST land on
 * that piece, not the global/unassigned bucket. This sits right next to the
 * change that made chat/terminal drops upload as UNASSIGNED
 * (`uploadFileTo(null, file)`) — that change is correct, but nothing stops a
 * future edit from "simplifying" this call site to match it, which would
 * silently break every asset a user drags onto a piece row.
 *
 * This is a source scan, not a render test, for the same reason as the
 * sibling files in this directory (editor-page-onboarding-reachable.test.ts,
 * editor-page-demo-offer-not-armed-by-selection.test.ts): mounting this page
 * means standing up a dozen providers (React Query, session state, active
 * piece, etc.), disproportionate to pinning one call site's argument.
 *
 * What this proves: `handleUploadFiles` calls `uploadFileTo` with the piece
 * id it was given, not `null`. What it does NOT prove: that the id threaded
 * through actually reaches this function correctly from the Resources panel's
 * drop handler, or that the UI wiring (`onUploadFiles={handleUploadFiles}`)
 * stays connected — those would need a render/integration test.
 */
describe("editor page — files dropped on a piece row stay piece-scoped", () => {
  const PAGE = join(process.cwd(), "app/(app)/editor/page.tsx");
  const source = readFileSync(PAGE, "utf8");

  it("calls uploadFileTo with the explicit target piece id, never null", () => {
    expect(source).toContain("await uploadFileTo(targetPieceId, file);");
    expect(source).not.toContain("uploadFileTo(null, file)");
  });

  it("is still wired to the Resources panel's onUploadFiles prop", () => {
    expect(source).toContain("onUploadFiles={handleUploadFiles}");
  });
});
