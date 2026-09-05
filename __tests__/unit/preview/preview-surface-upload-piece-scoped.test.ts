import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Files dropped on the timeline MUST upload into the open piece — the whole
 * point is that `onDropFiles` turns the upload straight into an overlay in
 * THAT piece's composition. A global/unassigned upload would still "succeed"
 * from the caller's point of view (a FileRecord comes back either way) while
 * quietly breaking overlay creation, since the piece the overlay is added to
 * and the piece the file belongs to would no longer match.
 *
 * This sits right next to the change that made chat/terminal drops upload as
 * UNASSIGNED (`uploadFileTo(null, file)` via `useFileUpload(null)`) — correct
 * there, but nothing stops a future edit from applying the same pattern here
 * by mistake.
 *
 * This is a source scan, not a render test: PreviewSurface pulls in the
 * transport, selection stores, keyframe ops, and React Query providers to
 * mount at all, disproportionate to pinning one hook call's argument. No
 * existing test in this repo renders PreviewSurface.
 *
 * What this proves: the timeline's upload hook is instantiated with the
 * component's own `pieceId` prop, not `null`. What it does NOT prove: that
 * `pieceId` itself is correct at runtime, that `onDropFiles` is actually
 * reachable from a real drag-and-drop gesture, or that the resulting overlay
 * lands in the right composition — those would need a render/e2e test.
 */
describe("preview surface — timeline file drops stay piece-scoped", () => {
  const FILE = join(process.cwd(), "components/preview/preview-surface.tsx");
  const source = readFileSync(FILE, "utf8");

  it("instantiates the upload hook with this piece's id, never null", () => {
    expect(source).toContain("const { upload: uploadFile } = useFileUpload(pieceId);");
    expect(source).not.toContain("useFileUpload(null)");
  });
});
