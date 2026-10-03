import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createTempStorageDir, cleanupTempDir } from "@/__tests__/helpers/test-storage";
import { LocalFileStorage } from "@/lib/storage/local";
import { addOverlay } from "@/mcp/tools/overlay-tools";
import { codeOutline, OUTLINE_TEXT_SOURCE } from "@/mcp/tools/code-outline-tool";
import { codeOutlineSchema } from "@/mcp/tools/schemas";
import { KIT_BODY } from "@/__tests__/helpers/fixtures/code-kit-body";

let tempDir: string;
vi.mock("@/lib/storage", () => ({ getStorage: async () => new LocalFileStorage(tempDir) }));

const pieceId = "piece1";
const rect = { x: 0, y: 0, width: 1080, height: 1920 };

type Outline = {
  totalLines: number;
  functions: Array<{ name: string; line: number; endLine: number }>;
  constants: Array<{ name: string; value?: string }>;
  fonts: string[];
  helpersUsed: string[];
  textSource: string;
  file: string;
  note: string;
  source?: { from: number; to: number; text: string };
  parseError?: { line?: number };
};

async function addCode(body: string, kind: "code" | "three" = "code"): Promise<string> {
  const res = await addOverlay({ pieceId, kind, displayName: "Kit", startTime: 0, duration: 3, rect, z: 0, opacity: 1, body });
  expect(res.success, JSON.stringify(res)).toBe(true);
  return (res.data as { overlayId: string }).overlayId;
}

describe("libi.code_outline", () => {
  beforeEach(() => { tempDir = createTempStorageDir(); });
  afterEach(() => cleanupTempDir(tempDir));

  it("a ~200-line body: the outline is small and correct, and says where the body file is", async () => {
    const overlayId = await addCode(KIT_BODY);
    const res = await codeOutline({ pieceId, overlayId });
    expect(res.success).toBe(true);
    const d = res.data as unknown as Outline;
    expect(d.totalLines).toBeGreaterThan(200);
    expect(d.functions.map((f) => f.name)).toContain("heart");
    expect(d.constants.find((c) => c.name === "PALETTE")?.value).toBe('["#ff5d8f", "#ffb703", "#3a86ff", "#06d6a0"]');
    expect(d.fonts).toEqual(["Inter", "Fraunces"]);
    expect(d.helpersUsed).toEqual(["drawRoundedRect", "easeOutCubic", "interpolate"]);
    expect(d.file).toBe(new LocalFileStorage(tempDir).localPath(pieceId, `overlays/${overlayId}/draw.jsx`));
    // Body-derived text is marked, once, at the top of the result.
    expect(d.textSource).toBe(OUTLINE_TEXT_SOURCE);
    expect(d.note).toContain("overlay body (untrusted)");
    // Small: the whole result is a fraction of the file it describes.
    expect(JSON.stringify(res).length).toBeLessThan(KIT_BODY.length / 2);
    // The line numbers are the FILE's: the function really starts there.
    const fileLines = KIT_BODY.split("\n");
    const heart = d.functions.find((f) => f.name === "heart")!;
    expect(fileLines[heart.line - 1]).toMatch(/^function heart\(/);
  });

  it("includeSource returns exactly the requested lines of the file, and the outline stays", async () => {
    const overlayId = await addCode(KIT_BODY);
    const outline = (await codeOutline({ pieceId, overlayId })).data as unknown as Outline;
    const heart = outline.functions.find((f) => f.name === "heart")!;
    const res = await codeOutline({ pieceId, overlayId, includeSource: { from: heart.line, to: heart.endLine } });
    const d = res.data as unknown as Outline;
    expect(d.source!.text).toBe(KIT_BODY.split("\n").slice(heart.line - 1, heart.endLine).join("\n"));
    expect(d.source).toMatchObject({ from: heart.line, to: heart.endLine });
    expect(d.functions.length).toBe(outline.functions.length);
    // The same text the file holds on disk.
    const onDisk = (await new LocalFileStorage(tempDir).read(pieceId, `overlays/${overlayId}/draw.jsx`)).toString("utf-8");
    expect(onDisk.split("\n").slice(heart.line - 1, heart.endLine).join("\n")).toBe(d.source!.text);
  });

  it("outline: false returns the line counts and the range only", async () => {
    const overlayId = await addCode(KIT_BODY);
    const d = (await codeOutline({ pieceId, overlayId, outline: false, includeSource: { from: 1, to: 3 } })).data as unknown as Outline & Record<string, unknown>;
    expect(d.totalLines).toBeGreaterThan(200);
    expect(d.source!.text.split("\n")).toHaveLength(3);
    expect(d.functions).toBeUndefined();
  });

  it("follows the file the agent edits: a changed body is outlined afresh", async () => {
    const overlayId = await addCode("const A = 1;\nfunction one(a) {}\n");
    await new LocalFileStorage(tempDir).save(pieceId, `overlays/${overlayId}/draw.jsx`, Buffer.from("const A = 1;\nfunction one(a) {}\nfunction two(b, c) {}\n"));
    const d = (await codeOutline({ pieceId, overlayId })).data as unknown as Outline;
    expect(d.functions.map((f) => f.name)).toEqual(["one", "two"]);
  });

  it("works on a three overlay's scene body too", async () => {
    const overlayId = await addCode("const SPEED = 2;\nfunction spin(m) { m.rotation.y += SPEED; }\nreturn (api) => spin(mesh);", "three");
    const d = (await codeOutline({ pieceId, overlayId })).data as unknown as Outline;
    expect(d.functions.map((f) => f.name)).toEqual(["spin"]);
    expect(d.constants.map((c) => c.name)).toEqual(["SPEED"]);
  });

  it("a body that no longer parses is a result with the position, not an error", async () => {
    const overlayId = await addCode("const A = 1;");
    await new LocalFileStorage(tempDir).save(pieceId, `overlays/${overlayId}/draw.jsx`, Buffer.from("const A = ;\nconst B = 2;\n"));
    const res = await codeOutline({ pieceId, overlayId });
    expect(res.success).toBe(true);
    const d = res.data as unknown as Outline;
    expect(d.parseError?.line).toBe(1);
    expect(d.functions).toBeUndefined();
    expect(d.note).toContain("does not parse");
  });

  it("refuses an overlay with no body, and an unknown id (naming the code overlays that exist)", async () => {
    const text = await addOverlay({ pieceId, kind: "text", startTime: 0, duration: 2, rect, z: 0, opacity: 1, content: "hi", font: "20px sans", color: "#fff", align: "center" });
    const textId = (text.data as { overlayId: string }).overlayId;
    const none = await codeOutline({ pieceId, overlayId: textId });
    expect(none.success).toBe(false);
    expect(none.error).toMatch(/no code body/);
    const codeId = await addCode("const A = 1;");
    const missing = await codeOutline({ pieceId, overlayId: "nope" });
    expect(missing.success).toBe(false);
    expect((missing.data as { codeOverlayIds: string[] }).codeOverlayIds).toEqual([codeId]);
  });

  it("a range past the end is refused with the file's real length", async () => {
    const overlayId = await addCode("const A = 1;\nconst B = 2;\n");
    const res = await codeOutline({ pieceId, overlayId, includeSource: { from: 9, to: 12 } });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/2 lines/);
  });

  it("the schema wants whole, positive line numbers", () => {
    expect(codeOutlineSchema.safeParse({ pieceId, overlayId: "o", includeSource: { from: 0, to: 3 } }).success).toBe(false);
    expect(codeOutlineSchema.safeParse({ pieceId, overlayId: "o", includeSource: { from: 1.5, to: 3 } }).success).toBe(false);
    expect(codeOutlineSchema.safeParse({ pieceId, overlayId: "o", includeSource: { from: 1, to: 3 } }).success).toBe(true);
  });
});
