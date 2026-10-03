import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createTempStorageDir, cleanupTempDir } from "@/__tests__/helpers/test-storage";
import { LocalFileStorage } from "@/lib/storage/local";
import { addOverlay, updateOverlay, getOverlays } from "@/mcp/tools/overlay-tools";
import { addOverlayToolSchema, updateOverlayToolSchema, layerOverrideSchema } from "@/mcp/tools/schemas";
import { readBodyWarnings } from "@/mcp/tools/snapshot-tools";
import { handleOverlayChange } from "@/lib/overlays/watcher";
import { KIT_BODY } from "@/__tests__/helpers/fixtures/code-kit-body";

let tempDir: string;
vi.mock("@/lib/storage", () => ({ getStorage: async () => new LocalFileStorage(tempDir) }));
// The watcher's draft-flip reads the DB and snapshots; neither matters to what is under test (both are try/caught there).
vi.mock("@/lib/composition/snapshots", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/composition/snapshots")>()), loadCurrentSnapshot: async () => null }));

const pieceId = "piece1";
const rect = { x: 0, y: 0, width: 1080, height: 1920 };

type AddData = {
  overlayId: string;
  codeFilePath: string;
  include?: { from: string; included: Array<{ name: string; sourceLine: number }>; skipped: Array<{ name: string; reason: string }>; unresolved: string[]; statementsLeftOut: number; bodyStartsAtLine: number };
  warnings?: Array<{ name: string; line: number }>;
  note?: string;
  textSource?: string;
};

async function add(body: string | undefined, extra: Record<string, unknown> = {}, kind: "code" | "three" = "code") {
  return addOverlay({ pieceId, kind, displayName: "End card", startTime: 0, duration: 3, rect, z: 0, opacity: 1, ...(body !== undefined ? { body } : {}), ...extra } as never);
}
const fileOf = (id: string) => new LocalFileStorage(tempDir).read(pieceId, `overlays/${id}/draw.jsx`).then((b) => b.toString("utf-8"));

describe("add_overlay include", () => {
  beforeEach(() => { tempDir = createTempStorageDir(); });
  afterEach(() => cleanupTempDir(tempDir));

  it("copies two helpers (and what they need) from a 200-line kit and says what it did; the file holds the assembled body", async () => {
    const kit = await add(KIT_BODY);
    const kitId = (kit.data as AddData).overlayId;
    const body = "const { ctx, width } = context;\nheart(ctx, width / 2, 100, 40);\nstar(ctx, 100, 100, 30);\n";
    const res = await add(body, { include: { fromOverlayId: kitId, names: ["heart", "star"] } });
    expect(res.success, JSON.stringify(res)).toBe(true);
    const d = res.data as AddData;
    expect(d.include!.from).toBe(kitId);
    expect(d.include!.included.map((i) => i.name)).toEqual(expect.arrayContaining(["heart", "star", "INK", "PAPER", "GRAIN", "rand", "seed"]));
    expect(d.include!.included.every((i) => i.sourceLine > 0)).toBe(true);
    expect(d.include!.unresolved).toEqual([]);
    expect(d.textSource).toBe("overlay body (untrusted)");
    expect(d.warnings).toBeUndefined();
    const onDisk = await fileOf(d.overlayId);
    expect(onDisk).toContain(`// ── included by libi from overlay ${kitId}`);
    expect(onDisk.endsWith(`// ── end include ──\n${body}`)).toBe(true);
    expect(onDisk.split("\n")[d.include!.bodyStartsAtLine - 1]).toBe("const { ctx, width } = context;");
    // far smaller than the kit it came from
    expect(onDisk.length).toBeLessThan(KIT_BODY.length / 2);
    // The overlay record still carries only the path, never the body.
    const got = await getOverlays({ pieceId } as never);
    expect(JSON.stringify(got)).not.toContain("function heart(");
  });

  it("a name the new body declares wins and is reported skipped", async () => {
    const kitId = ((await add(KIT_BODY)).data as AddData).overlayId;
    const res = await add("const INK = '#000';\nheart(context.ctx, 1, 2, 3);", { include: { fromOverlayId: kitId, names: ["heart"] } });
    const d = res.data as AddData;
    expect(d.include!.skipped.map((s) => s.name)).toContain("INK");
    expect(d.include!.included.map((i) => i.name)).not.toContain("INK");
  });

  it("without names it copies exactly what the body reads", async () => {
    const kitId = ((await add(KIT_BODY)).data as AddData).overlayId;
    const res = await add("const { ctx } = context;\nctx.fillStyle = PALETTE[0];\nsparkle(ctx, 1, 2, 3);", { include: { fromOverlayId: kitId } });
    const d = res.data as AddData;
    const names = d.include!.included.map((i) => i.name);
    expect(names).toEqual(expect.arrayContaining(["PALETTE", "sparkle", "INK", "PAPER", "GRAIN", "rand", "seed"]));
    expect(names).not.toContain("heart");
  });

  it("unresolved names are reported (the include is still written) and surface as warnings with their line", async () => {
    const kitId = ((await add(KIT_BODY)).data as AddData).overlayId;
    const res = await add("const { ctx } = context;\n\nblorp(ctx);\n", { include: { fromOverlayId: kitId } });
    expect(res.success).toBe(true);
    const d = res.data as AddData;
    expect(d.include!.unresolved).toEqual(["blorp"]);
    // Lines are the stored file's own: nothing is copied here, so the body starts at line 1.
    expect(d.warnings).toEqual([{ name: "blorp", line: 3 }]);
    expect(d.note).toMatch(/not defined/);
    expect(d.textSource).toBe("overlay body (untrusted)");
  });

  it("warning lines count the copied block: they index the stored file", async () => {
    const kitId = ((await add(KIT_BODY)).data as AddData).overlayId;
    const res = await add("heart(context.ctx, 1, 2, 3);\nnope();", { include: { fromOverlayId: kitId, names: ["heart"] } });
    const d = res.data as AddData;
    const onDisk = (await fileOf(d.overlayId)).split("\n");
    expect(onDisk[d.warnings![0]!.line - 1]).toBe("nope();");
  });

  it("the assembled body goes through the validator: a kit with a disallowed pattern (written to disk) is refused and nothing is created", async () => {
    const kitId = ((await add("const A = 1;")).data as AddData).overlayId;
    await new LocalFileStorage(tempDir).save(pieceId, `overlays/${kitId}/draw.jsx`, Buffer.from("function go() { return fetch('/x'); }\n"));
    const res = await add("go();", { include: { fromOverlayId: kitId, names: ["go"] } });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/fetch/);
    expect(JSON.stringify(await getOverlays({ pieceId } as never))).not.toContain("go();");
  });

  it("refuses an unknown source with the ids that exist, and writes nothing", async () => {
    const kitId = ((await add(KIT_BODY)).data as AddData).overlayId;
    const res = await add("heart();", { include: { fromOverlayId: "code-nope", names: ["heart"] } });
    expect(res.success).toBe(false);
    expect(res.error).toBe("include_source_not_found");
    expect((res.data as { sourceOverlayIds: string[] }).sourceOverlayIds).toEqual([kitId]);
  });

  it("refuses a source of the wrong body family (a three body cannot include from a code body, nor the reverse)", async () => {
    const codeId = ((await add(KIT_BODY)).data as AddData).overlayId;
    const threeId = ((await add("const SPEED = 2;\nreturn () => SPEED;", {}, "three")).data as AddData).overlayId;
    const a = await add("const m = 1;", { include: { fromOverlayId: codeId } }, "three");
    expect(a.error).toBe("include_source_kind");
    const b = await add("SPEED;", { include: { fromOverlayId: threeId } });
    expect(b.error).toBe("include_source_kind");
  });

  it("a three body includes from a three body", async () => {
    const threeId = ((await add("const SPEED = 2;\nfunction spin(m) { m.rotation.y += SPEED; }\nreturn () => 1;", {}, "three")).data as AddData).overlayId;
    const res = await add("const mesh = new THREE.Mesh();\nscene.add(mesh);\nreturn () => spin(mesh);", { include: { fromOverlayId: threeId } }, "three");
    expect(res.success, JSON.stringify(res)).toBe(true);
    expect((res.data as AddData).include!.included.map((i) => i.name).sort()).toEqual(["SPEED", "spin"]);
    expect((res.data as AddData).warnings).toBeUndefined();
  });

  it("include on a kind with no code is refused before anything is created", async () => {
    const res = await addOverlay({ pieceId, kind: "text", startTime: 0, duration: 2, rect, z: 0, opacity: 1, content: "hi", include: { fromOverlayId: "x" } } as never);
    expect(res.success).toBe(false);
    expect(res.error).toBe("include_needs_code");
  });

  it("without include nothing changes: a clean body returns no include and no warnings", async () => {
    const res = await add("const { ctx } = context; ctx.fillRect(0, 0, 1, 1);");
    const d = res.data as AddData;
    expect(d.include).toBeUndefined();
    expect(d.warnings).toBeUndefined();
    expect(d.textSource).toBeUndefined();
  });

  it("a body referencing an undefined `heart` is written, with a warning naming it and its line", async () => {
    const res = await add("const { ctx } = context;\nctx.fillStyle = '#f00';\nheart(ctx, 10, 10, 20);");
    expect(res.success).toBe(true);
    expect((res.data as AddData).warnings).toEqual([{ name: "heart", line: 3 }]);
  });

  it("the starter body, the documented helpers and the sandbox globals produce no warning", async () => {
    expect((await add(undefined)).data).not.toHaveProperty("warnings");
    const res = await add("const { ctx, width } = context;\nconst t = interpolate(context.time, [0, 1], [0, 1]);\ndrawRoundedRect(ctx, 0, 0, width, 4, 2, '#fff');\nctx.globalAlpha = Math.min(1, t);");
    expect(res.data).not.toHaveProperty("warnings");
  });
});

describe("update_overlay include", () => {
  beforeEach(() => { tempDir = createTempStorageDir(); });
  afterEach(() => cleanupTempDir(tempDir));

  it("prepends the needed helpers to an existing body and leaves the rest of the overlay alone", async () => {
    const kitId = ((await add(KIT_BODY)).data as AddData).overlayId;
    const cardBody = "const { ctx } = context;\nheart(ctx, 1, 2, 3);\n";
    const card = ((await add(cardBody)).data as AddData).overlayId;
    const res = await updateOverlay({ pieceId, overlayId: card, include: { fromOverlayId: kitId, names: ["heart"] } } as never);
    expect(res.success, JSON.stringify(res)).toBe(true);
    const d = res.data as AddData;
    expect(d.include!.included.map((i) => i.name)).toContain("heart");
    const onDisk = await fileOf(card);
    expect(onDisk.endsWith(`// ── end include ──\n${cardBody}`)).toBe(true);
    // The body is never part of the record, and no `include` field was stored.
    const rec = JSON.stringify(await getOverlays({ pieceId, overlayId: card } as never));
    expect(rec).not.toContain("function heart(");
    expect(rec).not.toContain('"include"');
  });

  it("combines with a structured patch in one call", async () => {
    const kitId = ((await add(KIT_BODY)).data as AddData).overlayId;
    const card = ((await add("heart(context.ctx, 1, 2, 3);")).data as AddData).overlayId;
    const res = await updateOverlay({ pieceId, overlayId: card, duration: 5, include: { fromOverlayId: kitId, names: ["heart"] } } as never);
    expect(res.success).toBe(true);
    const got = JSON.stringify(await getOverlays({ pieceId, overlayId: card } as never));
    expect(got).toMatch(/"duration":5/);
    expect(await fileOf(card)).toContain("function heart(");
  });

  it("a second include of the same names changes nothing (they are already declared)", async () => {
    const kitId = ((await add(KIT_BODY)).data as AddData).overlayId;
    const card = ((await add("heart(context.ctx, 1, 2, 3);")).data as AddData).overlayId;
    await updateOverlay({ pieceId, overlayId: card, include: { fromOverlayId: kitId, names: ["heart"] } } as never);
    const once = await fileOf(card);
    const res = await updateOverlay({ pieceId, overlayId: card, include: { fromOverlayId: kitId, names: ["heart"] } } as never);
    expect(res.success).toBe(true);
    expect((res.data as AddData).include!.included).toEqual([]);
    expect(await fileOf(card)).toBe(once);
  });

  it("refuses a non-code target, itself as the source, and an unknown overlay; nothing changes", async () => {
    const text = ((await addOverlay({ pieceId, kind: "text", startTime: 0, duration: 2, rect, z: 0, opacity: 1, content: "hi", font: "20px sans", color: "#fff", align: "center" } as never)).data as AddData).overlayId;
    const card = ((await add("const A = 1;")).data as AddData).overlayId;
    expect((await updateOverlay({ pieceId, overlayId: text, include: { fromOverlayId: card } } as never)).error).toBe("include_needs_code");
    expect((await updateOverlay({ pieceId, overlayId: card, include: { fromOverlayId: card } } as never)).error).toBe("include_source_kind");
    expect((await updateOverlay({ pieceId, overlayId: "nope", include: { fromOverlayId: card } } as never)).error).toMatch(/not found/);
    expect(await fileOf(card)).toBe("const A = 1;");
  });

  it("an include that would break the body is refused whole, so a structured patch in the same call is not applied", async () => {
    const kitId = ((await add("const A = 1;")).data as AddData).overlayId;
    await new LocalFileStorage(tempDir).save(pieceId, `overlays/${kitId}/draw.jsx`, Buffer.from("function go() { return fetch('/x'); }\n"));
    const card = ((await add("go();")).data as AddData).overlayId;
    const res = await updateOverlay({ pieceId, overlayId: card, duration: 9, include: { fromOverlayId: kitId, names: ["go"] } } as never);
    expect(res.success).toBe(false);
    expect(JSON.stringify(await getOverlays({ pieceId, overlayId: card } as never))).not.toMatch(/"duration":9/);
  });
});

describe("strict schemas", () => {
  it("add and update accept `include`, and refuse unknown keys inside it and at the top level", () => {
    const base = { pieceId, kind: "code", displayName: "x", startTime: 0, duration: 1, rect, z: 0, opacity: 1, body: "1;" };
    expect(addOverlayToolSchema.safeParse({ ...base, include: { fromOverlayId: "a", names: ["h"] } }).success).toBe(true);
    expect(addOverlayToolSchema.safeParse({ ...base, include: { fromOverlayId: "a", name: "h" } }).success).toBe(false);
    expect(addOverlayToolSchema.safeParse({ ...base, include: { names: ["h"] } }).success).toBe(false);
    expect(addOverlayToolSchema.safeParse({ ...base, includes: { fromOverlayId: "a" } }).success).toBe(false);
    expect(updateOverlayToolSchema.safeParse({ pieceId, overlayId: "o", include: { fromOverlayId: "a" } }).success).toBe(true);
    // update_overlay still takes no body
    const refused = updateOverlayToolSchema.safeParse({ pieceId, overlayId: "o", body: "x" });
    expect(refused.success).toBe(false);
    expect(JSON.stringify(refused)).toMatch(/include/);
    // a template's per-layer overrides never carry one
    expect(layerOverrideSchema.safeParse({ include: { fromOverlayId: "a" } }).success).toBe(false);
  });
});

describe("the watcher and get_piece_state: names nothing defines", () => {
  beforeEach(() => { tempDir = createTempStorageDir(); });
  afterEach(() => cleanupTempDir(tempDir));

  it("an edit to the code file that introduces an undefined name is reported on revalidation, and clears when fixed", async () => {
    const card = ((await add("const { ctx } = context;\nctx.fillRect(0, 0, 1, 1);")).data as AddData).overlayId;
    expect(await handleOverlayChange(pieceId)).toEqual({ ok: true });
    const storage = new LocalFileStorage(tempDir);
    await storage.save(pieceId, `overlays/${card}/draw.jsx`, Buffer.from("const { ctx } = context;\nctx.fillRect(0, 0, 1, 1);\nheart(ctx, 1, 2, 3);\n"));
    const res = await handleOverlayChange(pieceId);
    expect(res.ok).toBe(true);
    expect(res.bodyWarnings).toEqual([{ overlayId: card, kind: "code", warnings: [{ name: "heart", line: 3 }] }]);
    // get_piece_state reads the same check live, with the file to fix.
    const state = await readBodyWarnings(pieceId);
    expect(state).toEqual([{ overlayId: card, kind: "code", file: storage.localPath(pieceId, `overlays/${card}/draw.jsx`), warnings: [{ name: "heart", line: 3 }] }]);
    await storage.save(pieceId, `overlays/${card}/draw.jsx`, Buffer.from("const { ctx } = context;\nfunction heart() {}\nheart(ctx, 1, 2, 3);\n"));
    expect(await handleOverlayChange(pieceId)).toEqual({ ok: true });
    expect(await readBodyWarnings(pieceId)).toEqual([]);
  });

  it("a body that fails validation keeps the existing overlay_error path and is not also warned about", async () => {
    const card = ((await add("const A = 1;")).data as AddData).overlayId;
    await new LocalFileStorage(tempDir).save(pieceId, `overlays/${card}/draw.jsx`, Buffer.from("fetch('/x'); nope();\n"));
    expect(await handleOverlayChange(pieceId)).toEqual({ ok: true });
  });
});
