import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { eq, sql } from "drizzle-orm";
import { createTestDb, resetTestDb, seedPiece } from "@/__tests__/helpers/test-db";
import { pieces } from "@/lib/db/schema/sqlite";
import { TEMPLATE_LIMITS, type TemplateScaffold } from "@/lib/templates/scaffold";
import { templates as templatesTable, jobs as jobsTable } from "@/lib/db/schema/sqlite";

let testDb: ReturnType<typeof createTestDb>;
vi.mock("@/lib/db/client", () => ({ getDb: () => testDb }));
// The public catalog's network seam: unreachable, so scope "public" is the (empty) cache.
vi.mock("@/lib/templates/cloud/client", () => ({ fetchIndex: vi.fn(async () => ({ ok: false, error: "offline", reason: "unreachable" })) }));

import {
  createTemplate, getTemplate, listTemplates, searchTemplates, updateTemplate, deleteTemplate,
  recordUse, readScaffold, readInstructions, readTemplateFile, templateDir, templatePaths,
  getTemplateSummary, importTemplateFolder,
} from "@/lib/templates/store";

let home: string;
let srcDir: string;

function scaffold(over: Partial<TemplateScaffold> = {}): TemplateScaffold {
  return {
    schema: 1, name: "Lower third", description: "A name card", tags: ["promo"],
    canvas: { width: 1080, height: 1920, fps: 30 }, duration: 4,
    slots: [{ key: "headline", kind: "text", label: "Headline", required: true }],
    overlays: [
      { key: "title", kind: "text", startTime: 0, duration: 4, rect: { x: 0, y: 0, width: 1080, height: 200 }, z: 1, opacity: 1, text: { slot: "headline" }, font: "700 64px Inter", color: "#fff", align: "center" },
      { key: "logo", kind: "image", startTime: 0, duration: 4, rect: { x: 0, y: 0, width: 100, height: 100 }, z: 2, opacity: 1, source: { assetRef: "logo" } },
      { key: "fx", kind: "code", startTime: 0, duration: 4, rect: { x: 0, y: 0, width: 1080, height: 1920 }, z: 3, opacity: 1, codeFile: "overlays/fx/draw.jsx", displayName: "FX" },
    ] as TemplateScaffold["overlays"],
    audioClips: [], assets: [{ ref: "logo", kind: "image", file: "assets/logo.png" }], fonts: [], captionStyles: [],
    ...over,
  };
}

async function make(name = "Lower third", tags = ["promo"], description = "A name card") {
  return createTemplate({
    name, description, tags,
    scaffold: scaffold({ name, tags, description }),
    instructions: "# Purpose\nA name card.\n",
    copies: [{ rel: "assets/logo.png", from: path.join(srcDir, "logo.png") }],
    writes: [{ rel: "overlays/fx/draw.jsx", body: "const { ctx } = context;\nctx.fillRect(0,0,10,10);" }],
  });
}

describe("templates store", () => {
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "libi-tpl-"));
    process.env.LIBI_HOME = home;
    srcDir = fs.mkdtempSync(path.join(os.tmpdir(), "libi-tpl-src-"));
    fs.writeFileSync(path.join(srcDir, "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    testDb = createTestDb();
  });
  afterEach(() => {
    resetTestDb();
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(srcDir, { recursive: true, force: true });
  });

  it("creates the row and the folder: template.json, index.md, code file, asset with sha256/bytes", async () => {
    const row = await make();
    expect(getTemplate(row.id)?.name).toBe("Lower third");
    const dir = templateDir(row.id);
    expect(fs.existsSync(path.join(dir, "template.json"))).toBe(true);
    expect(fs.readFileSync(path.join(dir, "index.md"), "utf8")).toContain("Purpose");
    expect(fs.existsSync(path.join(dir, "overlays/fx/draw.jsx"))).toBe(true);
    expect(fs.existsSync(path.join(dir, "assets/logo.png"))).toBe(true);
    const read = await readScaffold(row.id);
    expect(read.ok).toBe(true);
    if (read.ok) {
      expect(read.scaffold.assets[0].bytes).toBe(4);
      expect(read.scaffold.assets[0].sha256).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(row.hasCode).toBe(true);
  });

  it("rejects bad tags and a missing copy source without leaving a folder behind", async () => {
    await expect(createTemplate({ name: "x", description: "", tags: ["Bad Tag"], scaffold: scaffold(), instructions: "", copies: [], writes: [] })).rejects.toThrow(/tags/);
    await expect(createTemplate({ name: "x", description: "", tags: [], scaffold: scaffold(), instructions: "", copies: [{ rel: "assets/logo.png", from: "/nope/logo.png" }], writes: [] })).rejects.toThrow();
    expect(fs.readdirSync(path.join(home, "templates"))).toHaveLength(0);
  });

  it("lists with uses and orders trending / most-used / newest", async () => {
    const a = await make("Alpha");
    const b = await make("Beta");
    const c = await make("Gamma");
    recordUse(b.id, null);
    recordUse(b.id, null);
    recordUse(a.id, null);
    // An old use for c: most-used counts it, trending (7 d) does not.
    testDb.run(sql`UPDATE templates SET use_count = 5 WHERE id = ${c.id}`);
    testDb.run(sql`INSERT INTO template_uses(id, template_id, used_at) VALUES ('old', ${c.id}, unixepoch() - 30*86400)`);
    // created_at has one-second granularity, so three creates in the same tick
    // would tie: stamp them apart to make "newest" deterministic.
    testDb.run(sql`UPDATE templates SET created_at = unixepoch() - 30 WHERE id = ${a.id}`);
    testDb.run(sql`UPDATE templates SET created_at = unixepoch() - 20 WHERE id = ${b.id}`);
    testDb.run(sql`UPDATE templates SET created_at = unixepoch() - 10 WHERE id = ${c.id}`);
    expect((await listTemplates({ order: "trending" })).map((t) => t.name)).toEqual(["Beta", "Alpha", "Gamma"]);
    expect((await listTemplates({ order: "most-used" })).map((t) => t.name)).toEqual(["Gamma", "Beta", "Alpha"]);
    expect((await listTemplates({ order: "newest" })).map((t) => t.name)).toEqual(["Gamma", "Beta", "Alpha"]);
    const beta = (await listTemplates({})).find((t) => t.name === "Beta")!;
    expect(beta.usesTotal).toBe(2);
    expect(beta.uses7d).toBe(2);
    expect(beta.lastUsedAt).not.toBeNull();
    expect(beta.slots).toHaveLength(1);
    expect(beta.id).toBe(b.id);
    expect(beta.cloudId).toBeNull();
  });

  it("searches by prefix over name/description/tags, filters by tags, and lists for a 1-char query", async () => {
    await make("Lower third", ["promo"]);
    await make("Product reveal", ["ugc"], "Shows the product");
    expect((await searchTemplates({ query: "lowe" })).map((t) => t.name)).toEqual(["Lower third"]);
    expect((await searchTemplates({ query: "name card" })).map((t) => t.name)).toEqual(["Lower third"]);
    expect((await searchTemplates({ query: "reveal", tags: ["promo"] })).map((t) => t.name)).toEqual([]);
    expect((await searchTemplates({ query: "l" })).map((t) => t.name).sort()).toEqual(["Lower third", "Product reveal"]);
    expect(await searchTemplates({ query: "lower", scope: "public" })).toEqual([]);
  });

  it("searches in any script: a Hebrew query finds only the Hebrew template; an accentless query finds accented text", async () => {
    await make("כתובית תחתונה", ["promo"], "כרטיס שם");
    await make("Lower third", ["promo"], "A name card");
    await make("Café crème", ["promo"], "Warm open");
    // Before: the query tokenized to nothing and every template was listed.
    expect((await searchTemplates({ query: "כתובית" })).map((t) => t.name)).toEqual(["כתובית תחתונה"]);
    expect((await searchTemplates({ query: "כרט" })).map((t) => t.name)).toEqual(["כתובית תחתונה"]);
    // unicode61's default remove_diacritics folds both sides.
    expect((await searchTemplates({ query: "cafe" })).map((t) => t.name)).toEqual(["Café crème"]);
    expect((await searchTemplates({ query: "crème" })).map((t) => t.name)).toEqual(["Café crème"]);
  });

  it("a Devanagari or Thai word is found as a whole (the quoted phrase keeps its pieces adjacent)", async () => {
    await make("हिन्दी शीर्षक", ["promo"], "नाम कार्ड");
    await make("คำบรรยาย ที่นี่", ["promo"], "ป้ายชื่อ");
    await make("Lower third", ["promo"], "A name card");
    expect((await searchTemplates({ query: "हिन्दी" })).map((t) => t.name)).toEqual(["हिन्दी शीर्षक"]);
    expect((await searchTemplates({ query: "शीर्षक" })).map((t) => t.name)).toEqual(["हिन्दी शीर्षक"]);
    expect((await searchTemplates({ query: "คำบรรยาย" })).map((t) => t.name)).toEqual(["คำบรรยาย ที่นี่"]);
  });

  it("searches over tags", async () => {
    await make("Lower third", ["promo"]);
    await make("Product reveal", ["ugc"], "Shows the product");
    expect((await searchTemplates({ query: "ugc" })).map((t) => t.name)).toEqual(["Product reveal"]);
  });

  it("updateTemplate bumps version, rewrites the row, and replace swaps the scaffold and files but keeps index.md", async () => {
    const row = await make();
    const u1 = await updateTemplate(row.id, { name: "Renamed", tags: ["x", "y"] });
    expect(u1?.version).toBe(2);
    expect(JSON.parse(u1!.tags)).toEqual(["x", "y"]);
    const u2 = await updateTemplate(row.id, {
      replace: { scaffold: scaffold({ overlays: [], assets: [] }), copies: [], writes: [] },
    });
    expect(u2?.version).toBe(3);
    expect(u2?.hasCode).toBe(false);
    expect(fs.existsSync(path.join(templateDir(row.id), "overlays/fx/draw.jsx"))).toBe(false);
    expect(await readInstructions(row.id)).toContain("Purpose");
  });

  it("a replace that cannot be built leaves the live template untouched", async () => {
    const row = await make();
    const before = fs.readFileSync(path.join(templateDir(row.id), "template.json"), "utf8");
    await expect(
      updateTemplate(row.id, {
        replace: {
          scaffold: scaffold(),
          copies: [{ rel: "assets/logo.png", from: "/nope/logo.png" }],
          writes: [{ rel: "overlays/fx/draw.jsx", body: "const { ctx } = context;" }],
        },
      }),
    ).rejects.toThrow();
    const dir = templateDir(row.id);
    expect(fs.readFileSync(path.join(dir, "template.json"), "utf8")).toBe(before);
    expect(fs.existsSync(path.join(dir, "overlays/fx/draw.jsx"))).toBe(true);
    expect(fs.existsSync(path.join(dir, "assets/logo.png"))).toBe(true);
    expect((await readScaffold(row.id)).ok).toBe(true);
    // The row is untouched too — no version bump for a replace that never landed.
    expect(getTemplate(row.id)?.version).toBe(1);
    expect(fs.readdirSync(path.join(home, "templates"))).toEqual([row.id]);
  });

  it("a replace whose scaffold is invalid leaves the live template untouched", async () => {
    const row = await make();
    await expect(
      updateTemplate(row.id, {
        // `logo` names an asset the replacement does not carry.
        replace: { scaffold: scaffold({ assets: [] }), copies: [], writes: [] },
      }),
    ).rejects.toThrow(/invalid scaffold/);
    expect((await readScaffold(row.id)).ok).toBe(true);
    expect(fs.existsSync(path.join(templateDir(row.id), "assets/logo.png"))).toBe(true);
    expect(getTemplate(row.id)?.version).toBe(1);
  });

  // A rename inside one directory can fail for reasons the store cannot foresee
  // (EPERM/EBUSY on Windows with a file under assets/ open). Failing the Nth
  // rename is the only way to reach the swap's own rollback deterministically.
  function failRenameOn(...calls: number[]) {
    const real = fsp.rename.bind(fsp);
    let n = 0;
    return vi.spyOn(fsp, "rename").mockImplementation(async (from, to) => {
      n += 1;
      if (calls.includes(n)) throw Object.assign(new Error("EPERM: rename refused"), { code: "EPERM" });
      return real(from, to);
    });
  }

  function goodReplace() {
    return {
      replace: {
        scaffold: scaffold(),
        copies: [{ rel: "assets/logo.png", from: path.join(srcDir, "logo.png") }],
        writes: [{ rel: "overlays/fx/draw.jsx", body: "const { ctx } = context;" }],
      },
    };
  }

  it("a rename failing mid-swap puts every original back and leaves no temp folder", async () => {
    const row = await make();
    const dir = templateDir(row.id);
    const before = fs.readFileSync(path.join(dir, "template.json"), "utf8");
    // Call 1 moves overlays/ aside; call 2 (assets/) fails — so template.json and
    // assets/ are still the ORIGINALS sitting in `dir`, and must survive.
    const spy = failRenameOn(2);
    await expect(updateTemplate(row.id, goodReplace())).rejects.toThrow(/EPERM/);
    spy.mockRestore();
    expect(fs.readFileSync(path.join(dir, "template.json"), "utf8")).toBe(before);
    expect(fs.existsSync(path.join(dir, "overlays/fx/draw.jsx"))).toBe(true);
    expect(fs.existsSync(path.join(dir, "assets/logo.png"))).toBe(true);
    expect((await readScaffold(row.id)).ok).toBe(true);
    expect(getTemplate(row.id)?.version).toBe(1);
    expect(fs.readdirSync(path.join(home, "templates"))).toEqual([row.id]);
  });

  it("keeps the aside folder when the rollback itself cannot restore an original", async () => {
    const row = await make();
    const dir = templateDir(row.id);
    // Call 1 moves overlays/ aside, call 2 fails, call 3 is the rollback's attempt
    // to put overlays/ back — fail that too and the only copy is in the aside dir.
    const spy = failRenameOn(2, 3);
    await expect(updateTemplate(row.id, goodReplace())).rejects.toThrow(/EPERM/);
    spy.mockRestore();
    const kept = fs.readdirSync(path.join(home, "templates")).filter((e) => e.includes(".old-"));
    expect(kept).toHaveLength(1);
    expect(fs.existsSync(path.join(home, "templates", kept[0], "overlays/fx/draw.jsx"))).toBe(true);
    // What the rollback never had to touch is still live.
    expect(fs.existsSync(path.join(dir, "assets/logo.png"))).toBe(true);
    expect(fs.existsSync(path.join(dir, "template.json"))).toBe(true);
    expect(getTemplate(row.id)?.version).toBe(1);
    expect(fs.readdirSync(path.join(home, "templates")).filter((e) => e.includes(".replace-"))).toEqual([]);
  });

  it("createTemplate refuses an id that is already taken and keeps its folder", async () => {
    const row = await make();
    await expect(
      createTemplate({
        id: row.id, name: "Impostor", description: "", tags: [],
        scaffold: scaffold({ overlays: [], assets: [] }), instructions: "", copies: [], writes: [],
      }),
    ).rejects.toThrow(/template_exists/);
    expect(getTemplate(row.id)?.name).toBe("Lower third");
    const read = await readScaffold(row.id);
    expect(read.ok).toBe(true);
    if (read.ok) expect(read.scaffold.name).toBe("Lower third");
    expect(fs.existsSync(path.join(templateDir(row.id), "assets/logo.png"))).toBe(true);
    expect(fs.existsSync(path.join(templateDir(row.id), "overlays/fx/draw.jsx"))).toBe(true);
    expect(await readInstructions(row.id)).toContain("Purpose");
  });

  // Review M3: one row per catalog template, a backstop for two installs racing across processes.
  it("holds one row per cloud id: a second row with the same cloud id is refused, any number without one is fine", async () => {
    const a = await make("One");
    const b = await make("Two");
    testDb.update(templatesTable).set({ cloudId: "abcdefghijklmnopqrst" }).where(eq(templatesTable.id, a.id)).run();
    expect(() => testDb.update(templatesTable).set({ cloudId: "abcdefghijklmnopqrst" }).where(eq(templatesTable.id, b.id)).run()).toThrow(/UNIQUE constraint failed: templates\.cloud_id/);
    await make("Three");
    expect(testDb.select().from(templatesTable).where(sql`${templatesTable.cloudId} IS NULL`).all()).toHaveLength(2);
  });

  it("updateTemplate returns null for an unknown id", async () => {
    expect(await updateTemplate("nope", { name: "x" })).toBeNull();
  });

  it("deleteTemplate removes the row and the folder", async () => {
    const row = await make();
    expect(await deleteTemplate(row.id)).toEqual({ deleted: true, cloudId: null });
    expect(getTemplate(row.id)).toBeNull();
    expect(fs.existsSync(templateDir(row.id))).toBe(false);
    expect(await deleteTemplate(row.id)).toEqual({ deleted: false, reason: "not_found" });
  });

  // Final review Minor 5.
  it("deleteTemplate refuses while a publish of it is running, and names the public copy of the user's own published one only", async () => {
    const row = await make();
    const CLOUD = "abcdefghijklmnopqrst";
    testDb.update(templatesTable).set({ cloudId: CLOUD }).where(sql`${templatesTable.id} = ${row.id}`).run();
    testDb.insert(jobsTable).values({ id: "job-p", kind: "template_publish", status: "running", paramsJson: JSON.stringify({ templateId: row.id }), paramsHash: "h" } as never).run();
    expect(await deleteTemplate(row.id)).toEqual({ deleted: false, reason: "publishing" });
    expect(getTemplate(row.id)).not.toBeNull();
    expect(fs.existsSync(templateDir(row.id))).toBe(true);
    testDb.update(jobsTable).set({ status: "failed" }).run();
    expect(await deleteTemplate(row.id)).toEqual({ deleted: true, cloudId: CLOUD });
    // An installed copy of someone else's template has no public copy of the user's.
    const installed = await make();
    testDb.update(templatesTable).set({ cloudId: CLOUD, origin: "installed" }).where(sql`${templatesTable.id} = ${installed.id}`).run();
    expect(await deleteTemplate(installed.id)).toEqual({ deleted: true, cloudId: null });
  });

  it("readScaffold reports a broken folder and listTemplates surfaces it", async () => {
    const row = await make();
    fs.writeFileSync(path.join(templateDir(row.id), "template.json"), JSON.stringify({ schema: 2 }));
    const read = await readScaffold(row.id);
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.reason).toMatch(/schema/);
    expect((await listTemplates({}))[0].broken).toMatch(/schema/);
    fs.rmSync(path.join(templateDir(row.id), "overlays"), { recursive: true });
    fs.writeFileSync(path.join(templateDir(row.id), "template.json"), JSON.stringify(scaffold()));
    const read2 = await readScaffold(row.id);
    expect(read2.ok).toBe(false);
    if (!read2.ok) expect(read2.reason).toMatch(/overlays\/fx\/draw\.jsx/);
  });

  it("refuses a symlink inside the folder and a path that escapes it", async () => {
    const row = await make();
    fs.symlinkSync("/etc/hosts", path.join(templateDir(row.id), "assets", "leak.png"));
    fs.writeFileSync(path.join(templateDir(row.id), "template.json"), JSON.stringify(scaffold({ assets: [{ ref: "logo", kind: "image", file: "assets/leak.png" }] })));
    const read = await readScaffold(row.id);
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.reason).toMatch(/symlink/);
    await expect(readTemplateFile(row.id, "../../etc/passwd")).rejects.toThrow(/template_path_escape/);
    await expect(readTemplateFile(row.id, "assets/leak.png")).rejects.toThrow(/template_path_escape/);
    expect(await readTemplateFile(row.id, "assets/logo.png")).toBe(fs.realpathSync(path.join(templateDir(row.id), "assets/logo.png")));
  });

  it("refuses a file reached through a symlinked folder", async () => {
    const row = await make();
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "libi-tpl-out-"));
    fs.writeFileSync(path.join(outside, "logo.png"), Buffer.from([1]));
    fs.rmSync(path.join(templateDir(row.id), "assets"), { recursive: true });
    fs.symlinkSync(outside, path.join(templateDir(row.id), "assets"));
    const read = await readScaffold(row.id);
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.reason).toMatch(/escapes the template folder/);
    fs.rmSync(outside, { recursive: true, force: true });
  });

  it("reports a code file over 128 KB", async () => {
    const row = await make();
    fs.writeFileSync(path.join(templateDir(row.id), "overlays/fx/draw.jsx"), "a".repeat(129 * 1024));
    const read = await readScaffold(row.id);
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.reason).toMatch(/over 128 KB/);
  });

  it("templatePaths and getTemplateSummary describe one template", async () => {
    const row = await make();
    const read = await readScaffold(row.id);
    expect(read.ok).toBe(true);
    if (read.ok) {
      const paths = templatePaths(row.id, read.scaffold);
      expect(paths.dir).toBe(templateDir(row.id));
      expect(paths.scaffoldPath).toBe(path.join(paths.dir, "template.json"));
      expect(paths.instructionsPath).toBe(path.join(paths.dir, "index.md"));
      expect(paths.codeFiles).toEqual([path.join(paths.dir, "overlays/fx/draw.jsx")]);
    }
    recordUse(row.id, null);
    const summary = await getTemplateSummary(row.id);
    expect(summary?.name).toBe("Lower third");
    expect(summary?.uses7d).toBe(1);
    expect(summary?.usesTotal).toBe(1);
    expect(summary?.hasPoster).toBe(false);
    expect(summary?.hasExample).toBe(false);
    expect(summary?.broken).toBeNull();
    expect(summary?.canvas).toEqual({ width: 1080, height: 1920, fps: 30 });
    expect(await getTemplateSummary("nope")).toBeNull();
  });

  it("templateDir rejects an unsafe id", () => {
    expect(() => templateDir("../x")).toThrow(/unsafe_piece_id/);
  });

  it("importTemplateFolder copies a folder in and validates it first", async () => {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), "libi-tpl-import-"));
    fs.mkdirSync(path.join(folder, "assets"));
    fs.mkdirSync(path.join(folder, "overlays/fx"), { recursive: true });
    fs.writeFileSync(path.join(folder, "template.json"), JSON.stringify(scaffold()));
    fs.writeFileSync(path.join(folder, "index.md"), "# Purpose\nImported.\n");
    fs.writeFileSync(path.join(folder, "assets/logo.png"), Buffer.from([1, 2, 3]));
    fs.writeFileSync(path.join(folder, "overlays/fx/draw.jsx"), "const { ctx } = context;");
    fs.writeFileSync(path.join(folder, "poster.jpg"), Buffer.from([0xff, 0xd8]));
    const row = await importTemplateFolder(folder, { origin: "local" });
    expect(row.origin).toBe("local");
    expect(fs.existsSync(path.join(templateDir(row.id), "poster.jpg"))).toBe(true);
    expect((await listTemplates({}))[0].hasPoster).toBe(true);
    fs.writeFileSync(path.join(folder, "template.json"), "{}");
    await expect(importTemplateFolder(folder, { origin: "local" })).rejects.toThrow(/schema/);
    fs.rmSync(folder, { recursive: true, force: true });
  });

  // Final review I5: import is the entry point for "an export, or a catalog
  // download" — a folder a stranger built. It used to follow symlinks and read
  // without a byte cap, so `assets/logo.png -> ~/.ssh/id_ed25519` was copied in
  // as a regular file and served by the media route.
  describe("importTemplateFolder refuses a hostile folder", () => {
    let folder: string;
    let outside: string;
    const saved = { ...TEMPLATE_LIMITS };
    beforeEach(() => {
      folder = fs.mkdtempSync(path.join(os.tmpdir(), "libi-tpl-import-"));
      outside = fs.mkdtempSync(path.join(os.tmpdir(), "libi-tpl-outside-"));
      fs.writeFileSync(path.join(outside, "secret"), "PRIVATE KEY");
      fs.mkdirSync(path.join(folder, "assets"));
      fs.mkdirSync(path.join(folder, "overlays/fx"), { recursive: true });
      fs.writeFileSync(path.join(folder, "template.json"), JSON.stringify(scaffold()));
      fs.writeFileSync(path.join(folder, "index.md"), "# Purpose\n");
      fs.writeFileSync(path.join(folder, "assets/logo.png"), Buffer.from([1, 2, 3]));
      fs.writeFileSync(path.join(folder, "overlays/fx/draw.jsx"), "const { ctx } = context;");
    });
    afterEach(() => {
      Object.assign(TEMPLATE_LIMITS as Record<string, number>, saved);
      fs.rmSync(folder, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    });
    /** Nothing was imported: no row, and no folder under the store. */
    async function expectNothingImported() {
      expect(testDb.select().from(templatesTable).all()).toEqual([]);
      expect(fs.existsSync(path.join(home, "templates")) ? fs.readdirSync(path.join(home, "templates")) : []).toEqual([]);
    }

    it("an asset that is a symlink pointing outside the folder", async () => {
      fs.rmSync(path.join(folder, "assets/logo.png"));
      fs.symlinkSync(path.join(outside, "secret"), path.join(folder, "assets/logo.png"));
      await expect(importTemplateFolder(folder, { origin: "installed" })).rejects.toThrow(/assets\/logo\.png.*symlink/);
      await expectNothingImported();
    });
    it("a symlinked index.md, template.json, poster or code file", async () => {
      for (const rel of ["index.md", "template.json", "poster.jpg", "overlays/fx/draw.jsx"]) {
        const real = path.join(folder, rel);
        const keep = fs.existsSync(real) ? fs.readFileSync(real) : null;
        if (keep) fs.rmSync(real);
        fs.symlinkSync(path.join(outside, "secret"), real);
        await expect(importTemplateFolder(folder, { origin: "installed" }), rel).rejects.toThrow(/symlink/);
        fs.rmSync(real);
        if (keep) fs.writeFileSync(real, keep);
      }
      await expectNothingImported();
    });
    // Final re-review 1: a hard link is a regular file, so the symlink check
    // let `assets/logo.png` share an inode with a file outside the folder (a
    // tar extractor can create one).
    it("an asset or index.md that is a hard link", async () => {
      for (const rel of ["assets/logo.png", "index.md"]) {
        const real = path.join(folder, rel);
        const keep = fs.readFileSync(real);
        fs.rmSync(real);
        fs.linkSync(path.join(outside, "secret"), real);
        await expect(importTemplateFolder(folder, { origin: "installed" }), rel).rejects.toThrow(/hard link/);
        fs.rmSync(real);
        fs.writeFileSync(real, keep);
      }
      await expectNothingImported();
    });
    it("a file reached through a symlinked assets/ folder", async () => {
      fs.rmSync(path.join(folder, "assets"), { recursive: true });
      fs.mkdirSync(path.join(outside, "assets"));
      fs.writeFileSync(path.join(outside, "assets/logo.png"), "PRIVATE KEY");
      fs.symlinkSync(path.join(outside, "assets"), path.join(folder, "assets"));
      await expect(importTemplateFolder(folder, { origin: "installed" })).rejects.toThrow(/escapes the template folder/);
      await expectNothingImported();
    });
    it("an asset over the per-file cap, and assets over the total cap", async () => {
      (TEMPLATE_LIMITS as Record<string, number>).assetBytes = 2;
      await expect(importTemplateFolder(folder, { origin: "installed" })).rejects.toThrow(/assets\/logo\.png over/);
      await expectNothingImported();
      Object.assign(TEMPLATE_LIMITS as Record<string, number>, saved);
      (TEMPLATE_LIMITS as Record<string, number>).totalBytes = 4;
      fs.writeFileSync(path.join(folder, "poster.jpg"), Buffer.from([0xff, 0xd8]));
      await expect(importTemplateFolder(folder, { origin: "installed" })).rejects.toThrow(/over .* in total/);
      await expectNothingImported();
    });
    it("an index.md, template.json or code file over its cap", async () => {
      fs.writeFileSync(path.join(folder, "index.md"), "x".repeat(TEMPLATE_LIMITS.instructionsBytes + 1));
      await expect(importTemplateFolder(folder, { origin: "installed" })).rejects.toThrow(/index\.md over/);
      fs.writeFileSync(path.join(folder, "index.md"), "ok");
      fs.writeFileSync(path.join(folder, "overlays/fx/draw.jsx"), "x".repeat(TEMPLATE_LIMITS.codeFileBytes + 1));
      await expect(importTemplateFolder(folder, { origin: "installed" })).rejects.toThrow(/draw\.jsx over/);
      fs.writeFileSync(path.join(folder, "overlays/fx/draw.jsx"), "ok");
      fs.writeFileSync(path.join(folder, "template.json"), JSON.stringify({ ...scaffold(), description: "", pad: "x".repeat(TEMPLATE_LIMITS.scaffoldBytes) }));
      await expect(importTemplateFolder(folder, { origin: "installed" })).rejects.toThrow(/template\.json over/);
      await expectNothingImported();
    });
  });

  // A catalog install (lib/templates/cloud/install.ts) imports through here.
  describe("importTemplateFolder for a catalog install", () => {
    let folder: string;
    beforeEach(() => {
      folder = fs.mkdtempSync(path.join(os.tmpdir(), "libi-tpl-import-"));
      fs.mkdirSync(path.join(folder, "assets"));
      fs.mkdirSync(path.join(folder, "overlays/fx"), { recursive: true });
      fs.writeFileSync(path.join(folder, "template.json"), JSON.stringify(scaffold({ name: "Published name", tags: ["old"] })));
      fs.writeFileSync(path.join(folder, "index.md"), "# Purpose\nv1\n");
      fs.writeFileSync(path.join(folder, "assets/logo.png"), Buffer.from([1, 2, 3]));
      fs.writeFileSync(path.join(folder, "overlays/fx/draw.jsx"), "const { ctx } = context;");
    });
    afterEach(() => fs.rmSync(folder, { recursive: true, force: true }));

    it("names the row and template.json from `metadata`, not the folder's template.json", async () => {
      const row = await importTemplateFolder(folder, {
        origin: "installed", cloudId: "abcdefghijklmnopqrst", version: 3,
        metadata: { name: "Listing name", description: "Listing words", tags: ["Listing", "new"] },
      });
      expect(row).toMatchObject({ origin: "installed", cloudId: "abcdefghijklmnopqrst", version: 3, name: "Listing name", description: "Listing words", tags: '["listing","new"]' });
      const read = await readScaffold(row.id);
      expect(read.ok && { name: read.scaffold.name, tags: read.scaffold.tags }).toEqual({ name: "Listing name", tags: ["listing", "new"] });
    });

    it("`replaceId` rebuilds an installed template in place: same id, new files, new row text and version", async () => {
      const first = await importTemplateFolder(folder, { origin: "installed", cloudId: "abcdefghijklmnopqrst", version: 1 });
      fs.writeFileSync(path.join(folder, "index.md"), "# Purpose\nv2\n");
      fs.writeFileSync(path.join(folder, "assets/logo.png"), Buffer.from([9, 9]));
      const second = await importTemplateFolder(folder, {
        origin: "installed", cloudId: "abcdefghijklmnopqrst", version: 2, replaceId: first.id,
        metadata: { name: "Renamed", description: "d2", tags: ["t2"] },
      });
      expect(second).toMatchObject({ id: first.id, version: 2, name: "Renamed", origin: "installed" });
      expect(testDb.select().from(templatesTable).all()).toHaveLength(1);
      expect(await readInstructions(first.id)).toBe("# Purpose\nv2\n");
      expect([...fs.readFileSync(path.join(templateDir(first.id), "assets/logo.png"))]).toEqual([9, 9]);
      // No staging or aside folder is left next to it.
      expect(fs.readdirSync(path.join(home, "templates"))).toEqual([first.id]);
    });

    it("`replaceId` leaves the old template whole when the new folder fails, and never replaces a local template", async () => {
      const first = await importTemplateFolder(folder, { origin: "installed", cloudId: "abcdefghijklmnopqrst", version: 1 });
      fs.writeFileSync(path.join(folder, "template.json"), JSON.stringify(scaffold({ assets: [{ ref: "logo", kind: "image", file: "assets/missing.png" }] })));
      await expect(importTemplateFolder(folder, { origin: "installed", version: 2, replaceId: first.id })).rejects.toThrow(/missing/);
      expect(getTemplate(first.id)).toMatchObject({ version: 1 });
      expect(await readInstructions(first.id)).toBe("# Purpose\nv1\n");
      expect(fs.readdirSync(path.join(home, "templates"))).toEqual([first.id]);
      const local = await make();
      fs.writeFileSync(path.join(folder, "template.json"), JSON.stringify(scaffold()));
      await expect(importTemplateFolder(folder, { origin: "installed", replaceId: local.id })).rejects.toThrow(/only an installed template/);
      expect(getTemplate(local.id)?.origin).toBe("local");
    });

    it("`replaceId` moves a symlink planted at the template's folder aside — nothing is written through it", async () => {
      const first = await importTemplateFolder(folder, { origin: "installed", cloudId: "abcdefghijklmnopqrst", version: 1 });
      const outside = fs.mkdtempSync(path.join(os.tmpdir(), "libi-tpl-outside-"));
      fs.writeFileSync(path.join(outside, "index.md"), "VICTIM");
      fs.rmSync(templateDir(first.id), { recursive: true });
      fs.symlinkSync(outside, templateDir(first.id));
      await importTemplateFolder(folder, { origin: "installed", version: 2, replaceId: first.id });
      expect(fs.lstatSync(templateDir(first.id)).isSymbolicLink()).toBe(false);
      expect(fs.readFileSync(path.join(outside, "index.md"), "utf8")).toBe("VICTIM");
      expect(fs.readdirSync(outside)).toEqual(["index.md"]);
      fs.rmSync(outside, { recursive: true, force: true });
    });
  });

  it("recordUse with a piece id survives that piece being deleted", async () => {
    const pieceId = seedPiece(testDb, { id: "p1" });
    const row = await make();
    recordUse(row.id, pieceId);
    testDb.delete(pieces).where(eq(pieces.id, pieceId)).run();
    expect(getTemplate(row.id)?.useCount).toBe(1);
  });
});

// Test mode and a normal boot share LIBI_HOME. A row linked to another catalog
// than the one this process reads is not linked HERE: no cloud id, no pending
// publish — and a note saying which catalog it came from.
describe("templates store — a link from another catalog", () => {
  const FIXTURE = "aaaaaaaaaaaaaaaaaaa2";
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "libi-tpl-"));
    process.env.LIBI_HOME = home;
    srcDir = fs.mkdtempSync(path.join(os.tmpdir(), "libi-tpl-src-"));
    fs.writeFileSync(path.join(srcDir, "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    testDb = createTestDb();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    resetTestDb();
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(srcDir, { recursive: true, force: true });
  });
  const link = (id: string, values: Partial<typeof templatesTable.$inferInsert>) => testDb.update(templatesTable).set(values).where(eq(templatesTable.id, id)).run();

  it("a test-mode link is no link in a normal boot: no cloud id, no pending publish, a note — and the row itself is kept", async () => {
    const row = await make();
    link(row.id, { origin: "installed", cloudId: FIXTURE, cloudSource: "test-mode", publishPending: "{}" });
    vi.stubEnv("LIBI_TEST_MODE", undefined);
    expect(getTemplate(row.id)).toMatchObject({ cloudId: null, publishPending: null, origin: "installed" });
    const summary = await getTemplateSummary(row.id);
    // Still installed: its words are still a stranger's, whichever catalog they came from.
    expect(summary).toMatchObject({ cloudId: null, origin: "installed", otherCatalog: "test-mode" });
    expect((await listTemplates()).find((t) => t.id === row.id)).toMatchObject({ cloudId: null, otherCatalog: "test-mode" });
    // Nothing was deleted: back in test mode it is the fixture's again.
    vi.stubEnv("LIBI_TEST_MODE", "1");
    expect(getTemplate(row.id)).toMatchObject({ cloudId: FIXTURE, publishPending: "{}" });
    expect(await getTemplateSummary(row.id)).toMatchObject({ cloudId: FIXTURE, otherCatalog: null });
  });

  it("the reverse: in test mode, a real catalog's link (or one recorded before sources were) is no link", async () => {
    const a = await make("A");
    const b = await make("B");
    link(a.id, { cloudId: "rrrrrrrrrrrrrrrrrrr5", cloudSource: "https://libi.nagellabs.com" });
    link(b.id, { cloudId: "sssssssssssssssssss6", cloudSource: null });
    vi.stubEnv("LIBI_TEST_MODE", "1");
    expect(await getTemplateSummary(a.id)).toMatchObject({ cloudId: null, otherCatalog: "https://libi.nagellabs.com" });
    expect(await getTemplateSummary(b.id)).toMatchObject({ cloudId: null, otherCatalog: "https://libi.nagellabs.com" });
    vi.stubEnv("LIBI_TEST_MODE", undefined);
    expect(await getTemplateSummary(a.id)).toMatchObject({ cloudId: "rrrrrrrrrrrrrrrrrrr5", otherCatalog: null });
    expect(await getTemplateSummary(b.id)).toMatchObject({ cloudId: "sssssssssssssssssss6", otherCatalog: null });
  });

  it("a local template never published has no note in either mode", async () => {
    const row = await make();
    vi.stubEnv("LIBI_TEST_MODE", "1");
    expect((await getTemplateSummary(row.id))?.otherCatalog).toBeNull();
    vi.stubEnv("LIBI_TEST_MODE", undefined);
    expect((await getTemplateSummary(row.id))?.otherCatalog).toBeNull();
  });

  it("an install records the catalog it came from", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "libi-tpl-import-"));
    const s = scaffold({ overlays: [], assets: [] });
    fs.writeFileSync(path.join(dir, "template.json"), JSON.stringify(s));
    vi.stubEnv("LIBI_TEST_MODE", "1");
    const row = await importTemplateFolder(dir, { origin: "installed", cloudId: FIXTURE, version: 1 });
    fs.rmSync(dir, { recursive: true, force: true });
    expect(testDb.select().from(templatesTable).where(eq(templatesTable.id, row.id)).get()?.cloudSource).toBe("test-mode");
  });

  it("recordUse records the catalog this process reads", async () => {
    const row = await make();
    vi.stubEnv("LIBI_TEST_MODE", "1");
    recordUse(row.id, null);
    vi.stubEnv("LIBI_TEST_MODE", undefined);
    recordUse(row.id, null);
    const sources = testDb.all<{ source: string | null }>(sql`SELECT source FROM template_uses ORDER BY rowid`).map((r) => r.source);
    expect(sources).toEqual(["test-mode", "https://libi.nagellabs.com"]);
  });
});
