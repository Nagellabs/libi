/* eslint-disable @typescript-eslint/no-explicit-any -- decoded tool results are loosely typed JSON */
/**
 * The libi.apply_ops engine, with a fake `OpInvoker` standing in for the tool layer (the real tools are
 * exercised through an MCP client in __tests__/integration/apply-ops-mcp.test.ts). The persistence layer,
 * the draft transaction and the DB are real: what matters here is what reaches the disk.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createTestDb, seedPiece } from "@/__tests__/helpers/test-db";
import { createTempStorageDir, cleanupTempDir } from "@/__tests__/helpers/test-storage";
import { LocalFileStorage } from "@/lib/storage/local";
import { folders, pieces } from "@/lib/db/schema/sqlite";
import { eq } from "drizzle-orm";

let testDb: ReturnType<typeof createTestDb>;
vi.mock("@/lib/db/client", () => ({ getDb: () => testDb }));
let tempDir: string;
vi.mock("@/lib/storage", () => ({ getStorage: async () => new LocalFileStorage(tempDir) }));
vi.mock("@/lib/navigation-events", () => ({ navigationEmitter: { emit: vi.fn() } }));
vi.mock("@/lib/libi-home", async (orig) => ({ ...(await orig<typeof import("@/lib/libi-home")>()), getCurrentPort: () => 4555 }));

import { loadManifest, saveManifest, type CompositionManifest } from "@/lib/composition/persistence";
import { applyOps, APPLY_OPS_MAX_OPS, type ApplyOpsParams, type OpInvoker, type OpOutcome } from "@/mcp/tools/apply-ops";
import { notify } from "@/mcp/notify";

const text = (id: string, startTime = 0) =>
  ({ id, kind: "text", startTime, duration: 2, rect: { x: 0, y: 0, width: 10, height: 10 }, z: 0, opacity: 1, content: id, font: "20px Inter", color: "#fff", align: "left" }) as never;
const base = (): CompositionManifest => ({
  width: 1080,
  height: 1920,
  fps: 30,
  overlays: [text("a"), text("b", 5)],
  audioClips: [{ id: "vo", kind: "standalone", fileId: "f", startTime: 0, duration: 4, trimStart: 0, volume: 1, enabled: true }] as never,
});

interface Call {
  tool: string;
  action?: string;
  args: Record<string, unknown>;
}

/** A fake tool layer: `libi.update_overlay` patches an overlay, `libi.audio_add_clip` adds a clip, ids are predictable. */
function fakeInvoker(opts: { failOn?: (call: Call) => string | null; extraValidate?: (call: Call) => { path: string; message: string }[] } = {}) {
  const calls: Call[] = [];
  let n = 0;
  const invoker: OpInvoker = {
    async validate(tool, action, args) {
      if (typeof args.duration === "string") return [{ path: "duration", message: "Expected number, received string" }];
      return opts.extraValidate?.({ tool, action, args }) ?? [];
    },
    async call(tool, action, args): Promise<OpOutcome> {
      const call = { tool, action, args };
      calls.push(call);
      const failure = opts.failOn?.(call);
      if (failure) return { ok: false, error: failure, hint: "check the id" };
      const pieceId = args.pieceId as string;
      notify.refreshQuery({ queryKey: "composition", pieceId });
      notify.refreshQuery({ queryKey: "composition", pieceId });
      const m = await loadManifest(pieceId);
      if (tool === "libi.update_overlay") {
        const o = m.overlays!.find((x) => x.id === args.overlayId);
        if (!o) return { ok: false, error: `Overlay ${String(args.overlayId)} not found` };
        Object.assign(o, Object.fromEntries(Object.entries(args).filter(([k]) => !["pieceId", "overlayId"].includes(k))));
        await saveManifest(pieceId, m);
        return { ok: true, data: { overlayId: args.overlayId } };
      }
      if (tool === "libi.audio_add_clip") {
        const id = `clip_${++n}_${pieceId}`;
        m.audioClips!.push({ id, kind: "standalone", fileId: String(args.fileId ?? "f"), startTime: Number(args.startTime ?? 0), duration: Number(args.duration ?? 1), trimStart: 0, volume: 1, enabled: true } as never);
        await saveManifest(pieceId, m);
        return { ok: true, data: { clipId: id } };
      }
      if (tool === "libi.audio_duck") {
        const clip = m.audioClips!.find((c) => c.id === args.clipId);
        if (!clip) return { ok: false, error: `Audio clip ${String(args.clipId)} not found` };
        (clip as any).duck = { sidechainClipIds: args.sidechainClipIds, reductionDb: args.reductionDb ?? -12 };
        await saveManifest(pieceId, m);
        return { ok: true };
      }
      if (tool === "libi.update_piece") {
        testDb.update(pieces).set({ name: String(args.name) }).where(eq(pieces.id, pieceId)).run();
        return { ok: true };
      }
      return { ok: true };
    },
  };
  return { invoker, calls };
}

const analyticsSpy = () => ({ toolUsed: vi.fn(), run: vi.fn() });
const disk = (id: string) => loadManifest(id);
const nameOf = (id: string) => testDb.select().from(pieces).where(eq(pieces.id, id)).get()!.name;

async function seed(id: string, folderId?: string, m: CompositionManifest = base()) {
  seedPiece(testDb, { id, name: id });
  if (folderId) testDb.update(pieces).set({ folderId }).where(eq(pieces.id, id)).run();
  await saveManifest(id, m);
  testDb.update(pieces).set({ hasDraft: false }).where(eq(pieces.id, id)).run();
}

describe("applyOps", () => {
  const realFetch = globalThis.fetch;
  let posted: any[];
  beforeEach(async () => {
    tempDir = createTempStorageDir();
    testDb = createTestDb();
    posted = [];
    globalThis.fetch = vi.fn(async (_u: string, init?: { body?: string }) => {
      posted.push(init?.body ? JSON.parse(init.body) : undefined);
      return new Response("{}");
    }) as never;
    await seed("p1");
    await seed("p2");
    await seed("p3");
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    cleanupTempDir(tempDir);
  });

  const run = (params: ApplyOpsParams, invoker: OpInvoker, analytics?: ReturnType<typeof analyticsSpy>) => applyOps(params, { invoker, analytics }, undefined);

  describe("bindings", () => {
    it("a name stands for each piece's own new id, in any id field, including inside arrays", async () => {
      const { invoker, calls } = fakeInvoker();
      const res = await run(
        {
          targets: { pieceIds: ["p1", "p2"] },
          ops: [
            { op: "audio_add_clip", as: "music", startTime: 1, duration: 3 },
            { op: "audio_add_clip", as: "second", startTime: 2, duration: 3 },
            { op: "audio_duck", action: "enable", clipId: "$music", sidechainClipIds: ["vo", "$second"] },
          ],
        },
        invoker,
      );
      expect(res.success).toBe(true);
      const ducks = calls.filter((c) => c.tool === "libi.audio_duck");
      expect(ducks.map((c) => c.args.clipId)).toEqual(["clip_1_p1", "clip_3_p2"]);
      expect(ducks.map((c) => c.args.sidechainClipIds)).toEqual([["vo", "clip_2_p1"], ["vo", "clip_4_p2"]]);
      const data = res.data as { pieces: { pieceId: string; bindings: Record<string, string> }[] };
      expect(data.pieces[0].bindings).toEqual({ music: "clip_1_p1", second: "clip_2_p1" });
      expect((await disk("p1")).audioClips!.find((c) => c.id === "clip_1_p1")).toMatchObject({ duck: { sidechainClipIds: ["vo", "clip_2_p1"] } });
    });

    it("only id fields are substituted: a $name in a text field stays text", async () => {
      const { invoker, calls } = fakeInvoker();
      await run(
        { targets: { pieceId: "p1" }, ops: [{ op: "audio_add_clip", as: "music", startTime: 0 }, { op: "update_overlay", overlayId: "a", content: "$music" }] },
        invoker,
      );
      expect(calls[1].args.content).toBe("$music");
    });

    it("a split binds its tail (newId, tailId, overlayId, clipId in that order)", async () => {
      const calls: Call[] = [];
      const invoker: OpInvoker = {
        validate: async () => [],
        call: async (tool, action, args) => {
          calls.push({ tool, action, args });
          return tool === "libi.clip" ? { ok: true, data: { headId: "h", tailId: "t1" } } : { ok: true };
        },
      };
      await run(
        { targets: { pieceId: "p1" }, ops: [{ op: "clip", action: "split", targetId: "a", atTime: 1, as: "tail" }, { op: "update_overlay", overlayId: "$tail" }] },
        invoker,
      );
      expect(calls[1].args.overlayId).toBe("t1");
    });

    it("an op that made nothing to bind fails the piece, naming `as`", async () => {
      const { invoker } = fakeInvoker();
      const res = await run({ targets: { pieceId: "p1" }, ops: [{ op: "update_piece", name: "x" }, { op: "audio_duck", action: "disable", clipId: "vo", as: "nothing" }] }, invoker);
      const piece = (res.data as any).pieces[0];
      expect(piece.status).toBe("rolled_back");
      expect(piece.errors[0]).toMatchObject({ op: 1, field: "as" });
    });

    it("refuses, before writing, a name used before it is bound, bound twice, or malformed", async () => {
      const { invoker, calls } = fakeInvoker();
      const res = await run(
        {
          targets: { pieceId: "p1" },
          ops: [
            { op: "audio_duck", action: "enable", clipId: "$later" },
            { op: "audio_add_clip", as: "later" },
            { op: "audio_add_clip", as: "later" },
            { op: "audio_add_clip", as: "9bad" },
          ],
        },
        invoker,
      );
      expect(res.success).toBe(false);
      const errors = (res.data as any).errors as { op: number; field?: string; error: string }[];
      expect(errors.find((e) => e.op === 0)).toMatchObject({ field: "clipId" });
      expect(errors.find((e) => e.op === 2)).toMatchObject({ field: "as" });
      expect(errors.find((e) => e.op === 3)).toMatchObject({ field: "as" });
      expect(calls).toHaveLength(0);
    });
  });

  describe("per piece overrides", () => {
    it("perPiece replaces fields for one piece only, and rejects a stray piece, a reserved field and a bad shape", async () => {
      const { invoker, calls } = fakeInvoker();
      await run(
        { targets: { pieceIds: ["p1", "p2"] }, ops: [{ op: "audio_add_clip", fileId: "default", startTime: 0, perPiece: { p2: { fileId: "special" } } }] },
        invoker,
      );
      expect(calls.map((c) => c.args.fileId)).toEqual(["default", "special"]);
      const bad = await run(
        { targets: { pieceId: "p1" }, ops: [{ op: "audio_add_clip", perPiece: { p1: { pieceId: "p9" } } }, { op: "audio_add_clip", perPiece: { p1: "x" as never } }] },
        invoker,
      );
      const errors = (bad.data as any).errors as { op: number; field?: string }[];
      expect(errors.map((e) => `${e.op}:${e.field}`)).toEqual(["0:perPiece.p1.pieceId", "1:perPiece"]);
    });
  });

  describe("rollback", () => {
    it("a failing op leaves THAT piece untouched (earlier ops included) and skips its later ops; the others land", async () => {
      const { invoker, calls } = fakeInvoker({ failOn: (c) => (c.args.pieceId === "p2" && c.args.overlayId === "b" ? "no way" : null) });
      const before = await disk("p2");
      const res = await run(
        {
          targets: { pieceIds: ["p1", "p2", "p3"] },
          ops: [
            { op: "update_overlay", overlayId: "a", startTime: 1 },
            { op: "update_overlay", overlayId: "b", startTime: 9 },
            { op: "update_overlay", overlayId: "a", duration: 6 },
          ],
        },
        invoker,
      );
      expect(res.success).toBe(false);
      expect(res.error).toBe("1 of 3 pieces were not changed (see pieces[].errors); the rest were applied.");
      const pieces_ = (res.data as any).pieces as any[];
      expect(pieces_.map((p) => p.status)).toEqual(["applied", "rolled_back", "applied"]);
      expect(pieces_[1].errors).toEqual([{ op: 1, tool: "update_overlay", error: "no way", hint: "check the id" }]);
      expect(pieces_[1].changes).toBeUndefined();
      // op 2 never ran for p2
      expect(calls.filter((c) => c.args.pieceId === "p2")).toHaveLength(2);
      expect(await disk("p2")).toEqual(before);
      expect((await disk("p1")).overlays!.find((o) => o.id === "a")).toMatchObject({ startTime: 1, duration: 6 });
      expect((await disk("p3")).overlays!.find((o) => o.id === "b")).toMatchObject({ startTime: 9 });
      // a rolled-back piece refreshes nothing
      expect(posted.filter((p) => p?.type === "refresh_query" && p.pieceId === "p2")).toHaveLength(0);
    });

    it("a thrown error is the piece's error, not the call's", async () => {
      const invoker: OpInvoker = { validate: async () => [], call: async () => { throw new Error("boom"); } };
      const res = await run({ targets: { pieceId: "p1" }, ops: [{ op: "update_overlay", overlayId: "a" }] }, invoker);
      expect((res.data as any).pieces[0]).toMatchObject({ status: "rolled_back", errors: [{ op: 0, error: "boom" }] });
    });

    it("update_piece is checked up front and runs only once the timeline is saved", async () => {
      const { invoker, calls } = fakeInvoker({ failOn: (c) => (c.args.overlayId === "zzz" ? "not found" : null) });
      await run({ targets: { pieceId: "p1" }, ops: [{ op: "update_piece", name: "Never" }, { op: "update_overlay", overlayId: "zzz" }] }, invoker);
      expect(nameOf("p1")).toBe("p1");
      expect(calls.some((c) => c.tool === "libi.update_piece")).toBe(false);
      await run({ targets: { pieceId: "p1" }, ops: [{ op: "update_piece", name: "Yes" }, { op: "update_overlay", overlayId: "a", startTime: 1 }] }, invoker);
      expect(nameOf("p1")).toBe("Yes");
      expect(calls.map((c) => c.tool).slice(-2)).toEqual(["libi.update_overlay", "libi.update_piece"]);
    });

    it("refuses a piece that was edited while the batch ran, writing nothing for it", async () => {
      const { invoker } = fakeInvoker();
      let inFlight!: () => void;
      const started = new Promise<void>((resolve) => (inFlight = resolve));
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      const slow: OpInvoker = {
        validate: invoker.validate,
        call: async (tool, action, args, extra) => {
          const out = await invoker.call(tool, action, args, extra);
          inFlight();
          await gate;
          return out;
        },
      };
      const running = run({ targets: { pieceId: "p1" }, ops: [{ op: "update_overlay", overlayId: "a", startTime: 3 }] }, slow);
      await started;
      // the user edits the piece on disk while the batch holds its copy
      const m = await disk("p1");
      m.overlays![1].startTime = 7;
      await saveManifest("p1", m);
      release();
      const res = await running;
      const piece = (res.data as any).pieces[0];
      expect(piece.status).toBe("refused");
      expect(piece.errors[0].error).toMatch(/edited while the batch ran/);
      const after = await disk("p1");
      expect(after.overlays!.find((o) => o.id === "a")!.startTime).toBe(0);
      expect(after.overlays!.find((o) => o.id === "b")!.startTime).toBe(7);
      expect(res.success).toBe(false);
    });
  });

  describe("dryRun", () => {
    it("runs every op against the in-memory copy, reports the changes and writes and notifies nothing", async () => {
      const { invoker } = fakeInvoker();
      const before = await Promise.all(["p1", "p2", "p3"].map(disk));
      const res = await run(
        { targets: { pieceIds: ["p1", "p2", "p3"] }, dryRun: true, ops: [{ op: "audio_add_clip", as: "m", startTime: 0, duration: 4 }, { op: "audio_duck", action: "enable", clipId: "$m", sidechainClipIds: ["vo"] }, { op: "update_piece", name: "N" }] },
        invoker,
      );
      expect(res.success).toBe(true);
      const data = res.data as any;
      expect(data.dryRun).toBe(true);
      expect(data.written).toBe(false);
      expect(data.pieces.map((p: any) => p.status)).toEqual(["dry_run", "dry_run", "dry_run"]);
      expect(data.pieces[0].changes.join("\n")).toMatch(/audio clip \$m=clip_\w+ added 0–4 duck \(sidechain vo; -12 dB\)/);
      expect(data.pieces[0].changes).toContain('piece: name → "N"');
      expect(await Promise.all(["p1", "p2", "p3"].map(disk))).toEqual(before);
      expect(nameOf("p1")).toBe("p1");
      expect(testDb.select().from(pieces).where(eq(pieces.id, "p1")).get()!.hasDraft).toBe(false);
      expect(posted.filter((p) => p?.type === "refresh_query")).toHaveLength(0);
      expect(data.summary).toMatch(/^dry run: 3 pieces, 3 ops: 3 would apply$/);
    });

    it("a dry run still fails a piece whose op would fail", async () => {
      const { invoker } = fakeInvoker();
      const res = await run({ targets: { pieceId: "p1" }, dryRun: true, ops: [{ op: "update_overlay", overlayId: "missing", startTime: 1 }] }, invoker);
      expect((res.data as any).pieces[0].status).toBe("rolled_back");
    });
  });

  describe("targets", () => {
    beforeEach(async () => {
      testDb.insert(folders).values({ id: "root", name: "Root" }).run();
      testDb.insert(folders).values({ id: "child", name: "Child", parentFolderId: "root" }).run();
      testDb.insert(folders).values({ id: "empty", name: "Empty" }).run();
      await seed("f1", "root");
      await seed("f2", "root");
      await seed("g1", "child");
    });
    const ids = (res: { data?: unknown }) => ((res.data as any).pieces as { pieceId: string }[]).map((p) => p.pieceId).sort();
    const op = [{ op: "update_overlay", overlayId: "a", startTime: 1 }];

    it("a folder is its pieces, not its subfolders' unless recursive", async () => {
      const { invoker } = fakeInvoker();
      expect(ids(await run({ targets: { folderId: "root" }, ops: op }, invoker))).toEqual(["f1", "f2"]);
      expect(ids(await run({ targets: { folderId: "root", recursive: true }, ops: op }, invoker))).toEqual(["f1", "f2", "g1"]);
    });

    it("says what is wrong with a folder: unknown, or empty (and how to include subfolders)", async () => {
      const { invoker } = fakeInvoker();
      expect((await run({ targets: { folderId: "nope" }, ops: op }, invoker)).error).toMatch(/no folder nope/);
      expect((await run({ targets: { folderId: "empty" }, ops: op }, invoker)).error).toMatch(/holds no pieces/);
      expect((await run({ targets: { folderId: "empty", recursive: false }, ops: op }, invoker)).error).toMatch(/recursive: true/);
    });

    it("needs exactly one target form", async () => {
      const { invoker } = fakeInvoker();
      expect((await run({ targets: {}, ops: op }, invoker)).error).toMatch(/exactly one of pieceId, pieceIds, folderId/);
      expect((await run({ targets: { pieceId: "p1", folderId: "root" }, ops: op }, invoker)).error).toMatch(/exactly one/);
      expect((await run({ targets: { pieceId: "p1", recursive: true }, ops: op }, invoker)).error).toMatch(/recursive only goes with folderId/);
      expect((await run({ targets: { pieceIds: [] }, ops: op }, invoker)).error).toMatch(/empty/);
    });

    it("an unknown piece id is refused alone, a duplicate id runs once", async () => {
      const { invoker, calls } = fakeInvoker();
      const res = await run({ targets: { pieceIds: ["p1", "p1", "ghost"] }, ops: op }, invoker);
      expect((res.data as any).pieces.map((p: any) => `${p.pieceId}:${p.status}`)).toEqual(["ghost:refused", "p1:applied"]);
      expect(calls).toHaveLength(1);
    });

    it("limits pieces and ops", async () => {
      const { invoker } = fakeInvoker();
      expect((await run({ targets: { pieceIds: Array.from({ length: 51 }, (_, i) => `x${i}`) }, ops: op }, invoker)).error).toMatch(/limit is 50/);
      expect((await run({ targets: { pieceId: "p1" }, ops: Array.from({ length: APPLY_OPS_MAX_OPS + 1 }, () => op[0]) }, invoker)).error).toMatch(/limit is 100/);
      expect((await run({ targets: { pieceId: "p1" }, ops: [] }, invoker)).error).toMatch(/empty/);
    });
  });

  describe("validation happens before the first write", () => {
    it("names the op index and the field for every problem at once, runs nothing", async () => {
      const { invoker, calls } = fakeInvoker();
      const res = await run(
        {
          targets: { pieceIds: ["p1", "p2"] },
          ops: [
            { op: "update_overlay", overlayId: "a", startTime: 1 },
            { op: "update_overlay", overlayId: "a", duration: "long" as never },
            { op: "libi.export_video" },
            { op: "snapshot", action: "commit" },
            { op: "audio_clip" },
            { op: "update_overlay", action: "x" },
            { op: "update_overlay", pieceId: "p9" },
            { op: "audio_add_clip", rights: { class: "owned" } },
            { op: "bogus" },
            { op: "" },
            {} as never,
          ],
        },
        invoker,
      );
      expect(res.success).toBe(false);
      expect(res.error).toMatch(/Nothing was changed\.$/);
      const errors = (res.data as any).errors as { op: number; field?: string; error: string }[];
      const by = Object.fromEntries(errors.map((e) => [e.op, e]));
      expect(by[0]).toBeUndefined();
      expect(by[1]).toMatchObject({ field: "duration" });
      expect(by[2].error).toMatch(/export_video is not allowed in a batch: it starts a background job/);
      expect(by[3].error).toMatch(/snapshot commit is not allowed in a batch: a batch only writes drafts/);
      expect(by[4]).toMatchObject({ field: "action" });
      expect(by[4].error).toMatch(/audio_clip needs `action`: one of update, remove, split, unlink, relink_overlay/);
      expect(by[5]).toMatchObject({ field: "action" });
      expect(by[6]).toMatchObject({ field: "pieceId" });
      expect(by[7]).toMatchObject({ field: "rights" });
      expect(by[8].error).toMatch(/unknown op "bogus"\. Allowed: .*update_overlay/);
      expect(by[9]).toMatchObject({ field: "op" });
      expect(by[10]).toMatchObject({ field: "op" });
      // the same arg problem on two pieces is reported once
      expect(errors.filter((e) => e.op === 1)).toHaveLength(1);
      expect(calls).toHaveLength(0);
    });

    it("an op's own arguments are checked with the tool's validator, for each piece's overrides", async () => {
      const { invoker } = fakeInvoker();
      const res = await run(
        { targets: { pieceIds: ["p1", "p2"] }, ops: [{ op: "update_overlay", overlayId: "a", duration: 1, perPiece: { p2: { duration: "x" } } }] },
        invoker,
      );
      expect((res.data as any).errors).toEqual([{ op: 0, field: "duration", error: "Expected number, received string" }]);
    });
  });

  describe("notifications", () => {
    it("one composition refresh and one piece-state refresh per applied piece, however many ops touched it", async () => {
      const { invoker } = fakeInvoker();
      await run(
        { targets: { pieceIds: ["p1", "p2", "p3"] }, ops: [{ op: "update_overlay", overlayId: "a", startTime: 1 }, { op: "update_overlay", overlayId: "b", startTime: 8 }, { op: "update_overlay", overlayId: "a", duration: 5 }] },
        invoker,
      );
      const refreshes = posted.filter((p) => p?.type === "refresh_query");
      expect(refreshes).toHaveLength(6);
      for (const id of ["p1", "p2", "p3"]) {
        expect(refreshes.filter((r) => r.pieceId === id).map((r) => r.queryKey).sort()).toEqual(["composition", "piece-state"]);
      }
    });
  });

  describe("analytics", () => {
    it("reports each OP once (tool + action), not ops x pieces, plus one bounded event per call", async () => {
      const { invoker } = fakeInvoker();
      const analytics = analyticsSpy();
      await run(
        { targets: { pieceIds: ["p1", "p2", "p3"] }, ops: [{ op: "update_overlay", overlayId: "a", startTime: 1 }, { op: "audio_add_clip", as: "m", startTime: 0 }, { op: "audio_duck", action: "enable", clipId: "$m", sidechainClipIds: ["vo"] }] },
        invoker,
        analytics,
      );
      expect(analytics.toolUsed.mock.calls).toEqual([["libi.update_overlay", undefined], ["libi.audio_add_clip", undefined], ["libi.audio_duck", "enable"]]);
      expect(analytics.run).toHaveBeenCalledTimes(1);
      expect(analytics.run).toHaveBeenCalledWith({ pieces: 5, ops: 3, dryRun: false, outcome: "applied" });
    });

    it("buckets the outcome: partial, failed, dry_run, invalid", async () => {
      const { invoker } = fakeInvoker({ failOn: (c) => (c.args.pieceId === "p1" ? "x" : null) });
      const analytics = analyticsSpy();
      const op = [{ op: "update_overlay", overlayId: "a", startTime: 1 }];
      await run({ targets: { pieceIds: ["p1", "p2"] }, ops: op }, invoker, analytics);
      await run({ targets: { pieceId: "p1" }, ops: op }, invoker, analytics);
      await run({ targets: { pieceId: "p2" }, ops: op, dryRun: true }, invoker, analytics);
      await run({ targets: { pieceId: "p2" }, ops: [{ op: "export_video" }] }, invoker, analytics);
      expect(analytics.run.mock.calls.map((c) => c[0].outcome)).toEqual(["partial", "failed", "dry_run", "invalid"]);
    });

    it("an invalid list reports no op as used", async () => {
      const { invoker } = fakeInvoker();
      const analytics = analyticsSpy();
      await run({ targets: { pieceId: "p1" }, ops: [{ op: "update_overlay", overlayId: "a" }, { op: "export_video" }] }, invoker, analytics);
      expect(analytics.toolUsed).not.toHaveBeenCalled();
    });
  });

  describe("result shape", () => {
    it("one line per change, a piece reading like an earlier one says so, an unchanged piece says unchanged", async () => {
      const { invoker } = fakeInvoker();
      const res = await run(
        { targets: { pieceIds: ["p1", "p2"] }, ops: [{ op: "update_overlay", overlayId: "a", startTime: 1 }, { op: "audio_add_clip", as: "m", startTime: 0, duration: 4 }] },
        invoker,
      );
      const [first, second] = (res.data as any).pieces;
      expect(first.changes).toEqual(["overlay a: start 0→1", expect.stringMatching(/^audio clip \$m=clip_\w+ added 0–4$/)]);
      expect(second.changes).toBe("same as p1");
      const noop = await run({ targets: { pieceId: "p3" }, ops: [{ op: "update_overlay", overlayId: "a", startTime: 0 }] }, invoker);
      expect((noop.data as any).pieces[0]).toMatchObject({ status: "unchanged", changes: [] });
      expect((noop.data as any).written).toBe(false);
    });
  });
});
