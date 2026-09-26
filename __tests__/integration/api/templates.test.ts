/**
 * The Templates page's data path, against a real test DB, a real temp
 * LIBI_HOME and a real template folder extracted from the every-kind fixture
 * piece. Only the seams that leave the process are stubbed (the jobs client
 * and the analytics queue).
 *
 * The media route is the one worth reading twice: it serves poster/example/
 * asset BYTES, so every way of naming a file that is not one of those —
 * traversal, a sibling of the assets folder, a planted symlink — must come
 * back 404 rather than the file.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { createTestDb, resetTestDb } from "@/__tests__/helpers/test-db";
import { createTempStorageDir, cleanupTempDir } from "@/__tests__/helpers/test-storage";
import { LocalFileStorage } from "@/lib/storage/local";
import { seedTemplateFixturePiece } from "@/__tests__/helpers/template-fixture-piece";
import { navigationEmitter } from "@/lib/navigation-events";

let testDb: ReturnType<typeof createTestDb>;
let storageDir: string;
vi.mock("@/lib/db/client", () => ({ getDb: () => testDb }));
// The public catalog's network seam: unreachable, so scope "public" is the (empty) cache.
vi.mock("@/lib/templates/cloud/client", () => ({ fetchIndex: vi.fn(async () => ({ ok: false, error: "offline", reason: "unreachable" })) }));
vi.mock("@/lib/storage", () => ({ getStorage: async () => new LocalFileStorage(storageDir) }));
vi.mock("@/mcp/jobs-client", () => ({
  enqueueJobOnServer: vi.fn(async () => ({ status: "new", jobId: "j", clientKey: "k" })),
  LibiServerUnavailableError: class extends Error {},
  logProxyGenEnqueueFailure: () => {},
}));
const trackServerEvent = vi.hoisted(() => vi.fn());
vi.mock("@/lib/analytics/server", () => ({ trackServerEvent }));

import { GET as list } from "@/app/api/templates/route";
import { GET as getOne, PATCH, DELETE } from "@/app/api/templates/[id]/route";
import { GET as media } from "@/app/api/templates/[id]/media/[name]/route";
import { extractScaffold } from "@/lib/templates/extract";
import { createTemplate, recordUse, templateDir } from "@/lib/templates/store";

const ctx = (id: string, name?: string) =>
  ({ params: Promise.resolve(name !== undefined ? { id, name } : { id }) }) as never;

describe("/api/templates", () => {
  let templateId: string;
  beforeEach(async () => {
    storageDir = createTempStorageDir();
    testDb = createTestDb();
    const { pieceId } = await seedTemplateFixturePiece(testDb as never, storageDir);
    const ex = await extractScaffold(pieceId);
    const row = await createTemplate({
      name: "Lower third",
      description: "A name card",
      tags: ["promo"],
      scaffold: ex.scaffold,
      instructions: "# Purpose\n",
      copies: ex.copies,
      writes: ex.writes,
    });
    templateId = row.id;
    fs.writeFileSync(path.join(templateDir(templateId), "poster.jpg"), Buffer.from([0xff, 0xd8, 0xff]));
    trackServerEvent.mockReset();
  });
  afterEach(() => {
    // Only THIS file's own template folder. The templates root is shared —
    // `LIBI_HOME` is one temp dir for files that don't override it, and
    // `template-tools.test.ts` / `materialize.test.ts` create real folders
    // under the same root — so removing the root here could delete another
    // file's live template between its beforeEach and its assertion.
    // `templateId` is unset if beforeEach threw, hence the guard.
    if (templateId) {
      // The media test plants `assets/leak.png -> /etc/hosts`. Remove the LINK
      // by name first rather than trusting a recursive rm not to follow it.
      const dir = templateDir(templateId);
      const leak = path.join(dir, "assets", "leak.png");
      if (fs.lstatSync(leak, { throwIfNoEntry: false })) fs.unlinkSync(leak);
      fs.rmSync(dir, { recursive: true, force: true });
    }
    resetTestDb();
    cleanupTempDir(storageDir);
  });

  it("GET lists and searches", async () => {
    const all = await (await list(new Request("http://x/api/templates"))).json();
    expect(all.templates).toHaveLength(1);
    expect(all.templates[0]).toMatchObject({
      id: templateId,
      hasPoster: true,
      hasCode: true,
      poster: `/api/templates/${templateId}/media/poster.jpg`,
      nickname: null,
    });
    const hit = await (await list(new Request("http://x/api/templates?q=name%20card&order=newest"))).json();
    expect(hit.templates).toHaveLength(1);
    const miss = await (await list(new Request("http://x/api/templates?q=zebra"))).json();
    expect(miss.templates).toEqual([]);
    const tagMiss = await (await list(new Request("http://x/api/templates?tags=ugc"))).json();
    expect(tagMiss.templates).toEqual([]);
    const pub = await (await list(new Request("http://x/api/templates?scope=public"))).json();
    expect(pub.templates).toEqual([]);
  });

  it("GET one returns summary, scaffold and instructions; 404 for a missing id", async () => {
    const res = await getOne(new Request("http://x"), ctx(templateId));
    const body = await res.json();
    expect(body.template.id).toBe(templateId);
    expect(body.scaffold.schema).toBe(1);
    expect(body.instructions).toContain("Purpose");
    // D5: the template's page shows its use on this machine.
    expect(body.usage).toEqual({ total: 0, d7: 0, d30: 0, lastUsedAt: null });
    recordUse(templateId, null);
    const used = await (await getOne(new Request("http://x"), ctx(templateId))).json();
    expect(used.usage).toMatchObject({ total: 1, d7: 1, d30: 1, lastUsedAt: expect.any(String) });
    expect((await getOne(new Request("http://x"), ctx("nope"))).status).toBe(404);
  });

  it("PATCH renames and re-tags, rejects bad tags, and emits refresh_query templates", async () => {
    const events: unknown[] = [];
    const onRefresh = (e: unknown) => events.push(e);
    navigationEmitter.on("refresh_query", onRefresh);
    try {
      const res = await PATCH(
        new Request("http://x", { method: "PATCH", body: JSON.stringify({ name: "Renamed", tags: ["x"] }) }),
        ctx(templateId),
      );
      expect(res.status).toBe(200);
      expect((await res.json()).template).toMatchObject({ name: "Renamed", tags: ["x"], version: 2 });
      expect(events).toContainEqual({ queryKey: "templates" });
      const bad = await PATCH(
        new Request("http://x", { method: "PATCH", body: JSON.stringify({ tags: ["Bad Tag"] }) }),
        ctx(templateId),
      );
      expect(bad.status).toBe(400);
      expect((await bad.json()).error).toBe("invalid_tags");
    } finally {
      navigationEmitter.off("refresh_query", onRefresh);
    }
  });

  it("PATCH with an empty body changes nothing and emits nothing", async () => {
    const events: unknown[] = [];
    const onRefresh = (e: unknown) => events.push(e);
    navigationEmitter.on("refresh_query", onRefresh);
    try {
      const before = (await (await getOne(new Request("http://x"), ctx(templateId))).json()).template;
      const res = await PATCH(new Request("http://x", { method: "PATCH", body: "{}" }), ctx(templateId));
      expect(res.status).toBe(200);
      const after = (await res.json()).template;
      expect(after.version).toBe(before.version);
      expect(after.updatedAt).toBe(before.updatedAt);
      expect(events).toEqual([]);
    } finally {
      navigationEmitter.off("refresh_query", onRefresh);
    }
  });

  it("DELETE removes the template, tracks the event, then 404s", async () => {
    expect((await DELETE(new Request("http://x", { method: "DELETE" }), ctx(templateId))).status).toBe(200);
    expect(trackServerEvent).toHaveBeenCalledWith("template_deleted");
    expect(fs.existsSync(templateDir(templateId))).toBe(false);
    expect((await DELETE(new Request("http://x", { method: "DELETE" }), ctx(templateId))).status).toBe(404);
  });

  it("media serves poster and assets by basename, refuses traversal, symlinks and unknown names", async () => {
    const poster = await media(new Request("http://x"), ctx(templateId, "poster.jpg"));
    expect(poster.status).toBe(200);
    expect(poster.headers.get("content-type")).toBe("image/jpeg");
    const logo = await media(new Request("http://x"), ctx(templateId, "logo.png"));
    expect(logo.status).toBe(200);
    expect(poster.headers.get("x-content-type-options")).toBe("nosniff");
    expect((await media(new Request("http://x"), ctx(templateId, "example.mp4"))).status).toBe(404);
    expect((await media(new Request("http://x"), ctx(templateId, "..%2Ftemplate.json"))).status).toBe(404);
    // What Next actually hands the handler: a route segment arrives DECODED.
    expect((await media(new Request("http://x"), ctx(templateId, "../template.json"))).status).toBe(404);
    expect((await media(new Request("http://x"), ctx(templateId, "template.json"))).status).toBe(404);
    fs.symlinkSync("/etc/hosts", path.join(templateDir(templateId), "assets", "leak.png"));
    expect((await media(new Request("http://x"), ctx(templateId, "leak.png"))).status).toBe(404);
  });

  // F12 (final review): the shared per-SEGMENT guard, not a substring one — an asset named by
  // its source title (`intro...v2.png`) is ordinary; traversal, encoded or not, and a Windows
  // hazard (`:`, a trailing dot) are still refused; the realpath check stays behind it.
  it("media uses the segment guard: `...` inside a name is served, traversal and hazards are not", async () => {
    const assets = path.join(templateDir(templateId), "assets");
    fs.writeFileSync(path.join(assets, "intro...v2.png"), Buffer.from([0x89, 0x50]));
    expect((await media(new Request("http://x"), ctx(templateId, "intro...v2.png"))).status).toBe(200);
    for (const name of ["..", "%2e%2e", "..%2Fposter.jpg", "a%5Cb.png", "logo.png:x", "logo.png.", ".hidden.png"]) {
      expect((await media(new Request("http://x"), ctx(templateId, name))).status, name).toBe(404);
    }
  });

  // D5–D6 review M6: an asset is named after its source file, so one can be called poster.jpg.
  it("media ?as=asset serves the ASSET named poster.jpg / example.mp4, never the template's own", async () => {
    const assets = path.join(templateDir(templateId), "assets");
    fs.writeFileSync(path.join(assets, "poster.jpg"), "the asset, not the poster");
    const own = await media(new Request("http://x"), ctx(templateId, "poster.jpg"));
    const asset = await media(new Request("http://x/?as=asset"), ctx(templateId, "poster.jpg"));
    expect(asset.status).toBe(200);
    expect(await asset.text()).toBe("the asset, not the poster");
    expect(await own.text()).not.toBe("the asset, not the poster");
    // An asset that isn't there is not answered with the template's own file.
    expect((await media(new Request("http://x/?as=asset"), ctx(templateId, "example.mp4"))).status).toBe(404);
  });

  it("media refuses an executable extension even when the bytes are really there", async () => {
    const assets = path.join(templateDir(templateId), "assets");
    for (const name of ["evil.js", "evil.html", "evil.json", "notes.txt"]) {
      fs.writeFileSync(path.join(assets, name), "alert(1)");
      expect((await media(new Request("http://x"), ctx(templateId, name))).status).toBe(404);
    }
  });

  it("media serves an SVG asset sandboxed, with nosniff", async () => {
    fs.writeFileSync(
      path.join(templateDir(templateId), "assets", "mark.svg"),
      '<svg xmlns="http://www.w3.org/2000/svg"/>',
    );
    const res = await media(new Request("http://x"), ctx(templateId, "mark.svg"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/svg+xml");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-security-policy")).toBe("default-src 'none'; sandbox");
  });

  it("media answers a Range request with 206 and the asked-for bytes", async () => {
    const res = await media(
      new Request("http://x", { headers: { range: "bytes=1-2" } }),
      ctx(templateId, "poster.jpg"),
    );
    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe("bytes 1-2/3");
    // The hardening headers ride the partial too — a Range request is just as
    // navigable as a plain one.
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array([0xd8, 0xff]));
  });
});
