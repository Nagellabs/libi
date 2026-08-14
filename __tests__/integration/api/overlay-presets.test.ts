/**
 * Task 3.2 — REST routes for overlay presets (save / list / apply / delete).
 *
 * Invokes the route handlers DIRECTLY (mirrors `asset-folders-route.test.ts`
 * for the `new Request(...)` + awaitable `{ params: Promise.resolve(...) }`
 * convention). Storage + preset-store I/O is wired through the temp-LIBI_HOME
 * harness (mirrors `overlay-preset-tools.test.ts`): `createTempStorageDir()`
 * sets `process.env.LIBI_HOME`, and `@/lib/storage` is mocked to a temp-dir
 * `LocalFileStorage` so manifests + preset JSON files live under the temp dir.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createTempStorageDir, cleanupTempDir } from "@/__tests__/helpers/test-storage";
import { LocalFileStorage } from "@/lib/storage/local";
import { addOverlay } from "@/mcp/tools/overlay-tools";
import { loadManifest } from "@/lib/composition/persistence";

let tempDir: string;
vi.mock("@/lib/storage", () => ({
  getStorage: async () => new LocalFileStorage(tempDir),
}));

// Import handlers AFTER the storage mock is wired.
import { GET, POST } from "@/app/api/overlay-presets/route";
import { DELETE } from "@/app/api/overlay-presets/[id]/route";
import { POST as APPLY } from "@/app/api/pieces/[pieceId]/overlays/[overlayId]/apply-preset/route";

const pieceId = "piece-overlay-presets-route-test";
const baseRect = { x: 0, y: 0, width: 200, height: 80 };

async function addStyledText(): Promise<string> {
  const add = await addOverlay({
    pieceId,
    kind: "text",
    startTime: 0,
    duration: 3,
    rect: baseRect,
    z: 1,
    opacity: 1,
    content: "Gold",
    font: "48px Inter",
    color: "#ffd400",
    align: "center",
    stroke: { color: "#000000", width: 6 },
    reveal: { mode: "pop" },
  } as never);
  expect(add.success).toBe(true);
  return (add.data as { overlayId: string }).overlayId;
}

async function addPlainText(): Promise<string> {
  const add = await addOverlay({
    pieceId,
    kind: "text",
    startTime: 0,
    duration: 2,
    rect: baseRect,
    z: 0,
    opacity: 1,
    content: "Plain",
    font: "48px Inter",
    color: "#ffffff",
    align: "left",
  } as never);
  expect(add.success).toBe(true);
  return (add.data as { overlayId: string }).overlayId;
}

describe("overlay-presets REST routes", () => {
  beforeEach(() => {
    tempDir = createTempStorageDir();
  });
  afterEach(() => cleanupTempDir(tempDir));

  it("saves, lists, applies, and deletes a preset via the routes", async () => {
    // 1. POST /api/overlay-presets — save a styled overlay's look.
    const styledId = await addStyledText();
    const saveRes = await POST(
      new Request("http://x/api/overlay-presets", {
        method: "POST",
        body: JSON.stringify({ pieceId, overlayId: styledId, name: "Gold Look" }),
      }),
    );
    expect(saveRes.status).toBe(200);
    const saved = (await saveRes.json()) as { presetId: string };
    expect(saved.presetId).toBe("gold-look");

    // 2. GET /api/overlay-presets?kind=text — list includes it.
    const listRes = await GET(new Request("http://x/api/overlay-presets?kind=text"));
    expect(listRes.status).toBe(200);
    const listed = (await listRes.json()) as { presets: { id: string }[] };
    expect(listed.presets.map((p) => p.id)).toContain("gold-look");

    // 3. POST apply-preset onto a SECOND plain overlay — captured fields appear.
    const plainId = await addPlainText();
    const applyRes = await APPLY(
      new Request(`http://x/api/pieces/${pieceId}/overlays/${plainId}/apply-preset`, {
        method: "POST",
        body: JSON.stringify({ presetId: "gold-look" }),
      }),
      { params: Promise.resolve({ pieceId, overlayId: plainId }) },
    );
    expect(applyRes.status).toBe(200);
    expect((await applyRes.json()) as { success: boolean }).toEqual({ success: true });

    const manifest = await loadManifest(pieceId);
    const target = manifest.overlays?.find((o) => o.id === plainId) as
      | Record<string, unknown>
      | undefined;
    expect(target).toBeDefined();
    expect(target!.color).toBe("#ffd400");
    expect(target!.stroke).toEqual({ color: "#000000", width: 6 });
    expect(target!.reveal).toEqual({ mode: "pop" });

    // 4. DELETE /api/overlay-presets/[id] — no longer listed.
    const delRes = await DELETE(
      new Request("http://x/api/overlay-presets/gold-look", { method: "DELETE" }),
      { params: Promise.resolve({ id: "gold-look" }) },
    );
    expect(delRes.status).toBe(200);

    const afterList = await GET(new Request("http://x/api/overlay-presets?kind=text"));
    const after = (await afterList.json()) as { presets: { id: string }[] };
    expect(after.presets.map((p) => p.id)).not.toContain("gold-look");
  });

  it("POST returns 404 when the overlay is missing", async () => {
    const res = await POST(
      new Request("http://x/api/overlay-presets", {
        method: "POST",
        body: JSON.stringify({ pieceId, overlayId: "nope", name: "X" }),
      }),
    );
    expect(res.status).toBe(404);
  });

  it("apply-preset returns 404 for an unknown preset", async () => {
    const plainId = await addPlainText();
    const res = await APPLY(
      new Request(`http://x/api/pieces/${pieceId}/overlays/${plainId}/apply-preset`, {
        method: "POST",
        body: JSON.stringify({ presetId: "does-not-exist" }),
      }),
      { params: Promise.resolve({ pieceId, overlayId: plainId }) },
    );
    expect(res.status).toBe(404);
  });
});
