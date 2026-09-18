// Storyboard read-modify-write operations must not lose each other's changes.
//
// QA 2026-09-18 (docs-local/qa/2026-09-18-storyboard-fit-rerun.md, "concurrent
// edit lost"): a title edit fired in the same millisecond as an add returned
// success and was silently lost — the add loaded the board, the edit saved its
// card, then the add's `saveStoryboard` rewrote EVERY card.json from its stale
// snapshot. `saveStoryboard` also deletes card dirs missing from the snapshot,
// so a stale snapshot could delete a card another request had just added.
//
// Writers live in TWO processes (the Next server's routes, and the MCP child
// that runs `mcp/tools/storyboard-tools.ts` in-process), so the "two module
// instances" case below simulates a second process: separate in-memory state,
// same files on disk.
import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import { spawn, type ChildProcess } from "child_process";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createTempStorageDir, cleanupTempDir } from "@/__tests__/helpers/test-storage";
import { resetStorage } from "@/lib/storage";
import {
  addStoryboardCard,
  loadStoryboard,
  loadCard,
  updateCardFields,
  updateManifestLayout,
  appendClipTake,
  setCardReference,
  mutateStoryboard,
} from "@/lib/storyboard/repo";
import {
  withStoryboardLock,
  storyboardLockPath,
  StoryboardBusyError,
  STORYBOARD_BUSY_MESSAGE,
  __setStoryboardLockTuningForTests,
  __storyboardLockStatsForTests,
} from "@/lib/storyboard/lock";
import { serverLogger } from "@/lib/logger";
import {
  addStoryboardCard as addCardTool,
  editStoryboardCard,
  approveStoryboardStage,
  attachStoryboardClip,
} from "@/mcp/tools/storyboard-tools";

const pieceId = "piece_concurrency";
const ctx = { pieceId };
/** Child processes spawned by the cross-pid test; killed in afterEach so a
 *  failed or timed-out test never leaves one running. */
const children: ChildProcess[] = [];

describe("storyboard concurrent mutations", () => {
  beforeEach(() => {
    createTempStorageDir();
    resetStorage();
    __setStoryboardLockTuningForTests();
  });
  afterEach(() => {
    for (const cp of children.splice(0)) if (cp.exitCode === null && cp.signalCode === null) cp.kill("SIGKILL");
    vi.restoreAllMocks();
    __setStoryboardLockTuningForTests();
    cleanupTempDir();
    resetStorage();
  });

  it("concurrent adds all persist, in cardOrder and on disk", async () => {
    const N = 12;
    await Promise.all(
      Array.from({ length: N }, (_, i) => addStoryboardCard(pieceId, { id: `c${i}`, title: `T${i}` })),
    );
    const sb = await loadStoryboard(pieceId);
    expect(sb?.cardOrder.slice().sort()).toEqual(Array.from({ length: N }, (_, i) => `c${i}`).sort());
    expect(sb?.cards).toHaveLength(N);
  });

  it("title edits concurrent with adds are not overwritten (the QA race)", async () => {
    for (let i = 0; i < 4; i++) await addStoryboardCard(pieceId, { id: `c${i}`, title: `Scene ${i}` });
    const ops: Promise<unknown>[] = [];
    for (let i = 0; i < 4; i++) {
      ops.push(addStoryboardCard(pieceId, { id: `n${i}`, title: `New ${i}` }));
      ops.push(updateCardFields(pieceId, `c${i}`, { title: `Edited ${i}` }));
    }
    await Promise.all(ops);
    for (let i = 0; i < 4; i++) {
      expect((await loadCard(pieceId, `c${i}`))?.title).toBe(`Edited ${i}`);
      expect((await loadCard(pieceId, `n${i}`))?.title).toBe(`New ${i}`);
    }
    expect((await loadStoryboard(pieceId))?.cards).toHaveLength(8);
  });

  it("a layout save concurrent with adds never deletes a just-added card", async () => {
    await addStoryboardCard(pieceId, { id: "c0", title: "first" });
    const ops: Promise<unknown>[] = [];
    for (let i = 1; i <= 6; i++) {
      ops.push(addStoryboardCard(pieceId, { id: `c${i}`, title: `T${i}` }));
      ops.push(updateManifestLayout(pieceId, { positions: { c0: { x: i, y: i } } }));
    }
    await Promise.all(ops);
    const sb = await loadStoryboard(pieceId);
    expect(sb?.cards.map((c) => c.id).sort()).toEqual(["c0", "c1", "c2", "c3", "c4", "c5", "c6"]);
    for (let i = 0; i <= 6; i++) {
      expect(await loadCard(pieceId, `c${i}`)).not.toBeNull();
    }
  });

  it("per-card mutations on the same card all land", async () => {
    await addStoryboardCard(pieceId, { id: "a", title: "a" });
    await addStoryboardCard(pieceId, { id: "b", title: "b" });
    await Promise.all([
      appendClipTake(pieceId, "a", "f1"),
      updateCardFields(pieceId, "a", { title: "retitled" }),
      setCardReference(pieceId, "a", "image_url", { fromCardId: "b" }),
      updateCardFields(pieceId, "a", { description: "desc" }),
    ]);
    const a = await loadCard(pieceId, "a");
    expect(a?.title).toBe("retitled");
    expect(a?.description).toBe("desc");
    expect(a?.clips?.map((c) => c.fileId)).toEqual(["f1"]);
    expect(a?.inheritedRefs?.image_url).toEqual({ fromCardId: "b" });
  });

  it("MCP tools: edit_storyboard_card + add + approve + attach concurrently all persist", async () => {
    for (let i = 1; i <= 3; i++) await addCardTool({ pieceId, card: { title: `Scene ${i}` } }, ctx);
    const results = await Promise.all([
      addCardTool({ pieceId, card: { id: "card_x", title: "X" } }, ctx),
      editStoryboardCard({ pieceId, cardId: "card_1", fields: { title: "Edited 1" } }, ctx),
      addCardTool({ pieceId, card: { id: "card_y", title: "Y" } }, ctx),
      editStoryboardCard({ pieceId, cardId: "card_2", fields: { title: "Edited 2" } }, ctx),
      approveStoryboardStage({ pieceId, cardId: "card_3", stage: "schematic" }, ctx),
      attachStoryboardClip({ pieceId, cardId: "card_3", fileId: "clip3" }, ctx),
    ]);
    expect(results.every((r) => r.success)).toBe(true);
    expect((await loadCard(pieceId, "card_1"))?.title).toBe("Edited 1");
    expect((await loadCard(pieceId, "card_2"))?.title).toBe("Edited 2");
    const c3 = await loadCard(pieceId, "card_3");
    expect(c3?.approvals.schematic).toBe(true);
    expect(c3?.clips?.map((c) => c.fileId)).toEqual(["clip3"]);
    expect((await loadStoryboard(pieceId))?.cardOrder).toEqual(
      expect.arrayContaining(["card_1", "card_2", "card_3", "card_x", "card_y"]),
    );
  });

  it("serializes across separate module instances (a second process) via the file lock", async () => {
    await addStoryboardCard(pieceId, { id: "c0", title: "Scene 0" });
    vi.resetModules();
    const other = (await import("@/lib/storyboard/repo")) as typeof import("@/lib/storyboard/repo");
    const ops: Promise<unknown>[] = [];
    for (let i = 1; i <= 6; i++) {
      ops.push((i % 2 ? other : { addStoryboardCard }).addStoryboardCard(pieceId, { id: `c${i}`, title: `T${i}` }));
      ops.push(other.updateCardFields(pieceId, "c0", { description: `d${i}` }));
      ops.push(updateCardFields(pieceId, "c0", { title: `Edited ${i}` }));
    }
    await Promise.all(ops);
    const sb = await loadStoryboard(pieceId);
    expect(sb?.cards.map((c) => c.id).sort()).toEqual(["c0", "c1", "c2", "c3", "c4", "c5", "c6"]);
    const c0 = await loadCard(pieceId, "c0");
    expect(c0?.title).toBe("Edited 6");
    expect(c0?.description).toBe("d6");
  });

  it("steals a lock left behind by a dead process, and releases its own", async () => {
    const { storyboardLockPath } = await import("@/lib/storyboard/lock");
    const lockPath = storyboardLockPath(pieceId);
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    // A pid that cannot be alive: far above any real pid_max.
    fs.writeFileSync(lockPath, JSON.stringify({ pid: 2 ** 30, acquiredAt: Date.now() }));
    await addStoryboardCard(pieceId, { id: "c0", title: "after stale" });
    expect((await loadCard(pieceId, "c0"))?.title).toBe("after stale");
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it("a callback that throws releases the lock; the next mutation succeeds", async () => {
    await expect(
      mutateStoryboard(pieceId, () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(fs.existsSync(storyboardLockPath(pieceId))).toBe(false);
    await addStoryboardCard(pieceId, { id: "c0", title: "after throw" });
    expect((await loadCard(pieceId, "c0"))?.title).toBe("after throw");
  });

  it("gives up with a clear busy error at ONE deadline, and the queue keeps working", async () => {
    __setStoryboardLockTuningForTests({ acquireTimeoutMs: 80 });
    let releaseHolder!: () => void;
    const held = new Promise<void>((r) => { releaseHolder = r; });
    const holder = withStoryboardLock(pieceId, () => held);
    const started = Date.now();
    const waiter = withStoryboardLock(pieceId, () => "never");
    await expect(waiter).rejects.toBeInstanceOf(StoryboardBusyError);
    await expect(waiter).rejects.toThrow(STORYBOARD_BUSY_MESSAGE);
    expect(Date.now() - started).toBeLessThan(1000);
    // A later caller still queues behind the holder, not beside it.
    let holderDone = false;
    const later = withStoryboardLock(pieceId, () => holderDone);
    releaseHolder();
    await holder.then(() => { holderDone = true; });
    await expect(later).resolves.toBe(true);
  });

  describe("hard links unavailable (exFAT / FAT32 / some SMB)", () => {
    const enotsup = () => Object.assign(new Error("link not supported"), { code: "ENOTSUP" });

    it("falls back to exclusive create when link fails with ENOTSUP", async () => {
      const link = vi.spyOn(fsp, "link").mockRejectedValue(enotsup());
      await Promise.all(Array.from({ length: 8 }, (_, i) => addStoryboardCard(pieceId, { id: `c${i}`, title: `T${i}` })));
      expect(link).toHaveBeenCalled();
      expect((await loadStoryboard(pieceId))?.cards).toHaveLength(8);
      expect(fs.existsSync(storyboardLockPath(pieceId))).toBe(false);
    });

    it("serializes two module instances (processes) through the fallback", async () => {
      vi.spyOn(fsp, "link").mockRejectedValue(enotsup());
      await addStoryboardCard(pieceId, { id: "c0", title: "Scene 0" });
      vi.resetModules();
      const other = (await import("@/lib/storyboard/repo")) as typeof import("@/lib/storyboard/repo");
      const ops: Promise<unknown>[] = [];
      for (let i = 1; i <= 5; i++) {
        ops.push(other.updateCardFields(pieceId, "c0", { description: `d${i}` }));
        ops.push(updateCardFields(pieceId, "c0", { title: `Edited ${i}` }));
        ops.push((i % 2 ? other : { addStoryboardCard }).addStoryboardCard(pieceId, { id: `c${i}`, title: `T${i}` }));
      }
      await Promise.all(ops);
      const c0 = await loadCard(pieceId, "c0");
      expect(c0?.title).toBe("Edited 5");
      expect(c0?.description).toBe("d5");
      expect((await loadStoryboard(pieceId))?.cards).toHaveLength(6);
    });

    it("an empty lock file (holder mid-write) is held while young, stolen once old", async () => {
      __setStoryboardLockTuningForTests({ acquireTimeoutMs: 100, unreadableGraceMs: 10_000 });
      const lockPath = storyboardLockPath(pieceId);
      fs.mkdirSync(path.dirname(lockPath), { recursive: true });
      fs.writeFileSync(lockPath, "");
      await expect(withStoryboardLock(pieceId, () => "x")).rejects.toBeInstanceOf(StoryboardBusyError);
      expect(fs.existsSync(lockPath)).toBe(true);
      const old = new Date(Date.now() - 60_000);
      fs.utimesSync(lockPath, old, old);
      await expect(withStoryboardLock(pieceId, () => "got it")).resolves.toBe("got it");
      expect(fs.existsSync(lockPath)).toBe(false);
    });
  });

  it("treats a transient EPERM/EBUSY from link as held and retries (Windows scanners)", async () => {
    __setStoryboardLockTuningForTests({ accessErrorsTransient: true }); // as on Windows
    const realLink = fsp.link.bind(fsp);
    let calls = 0;
    vi.spyOn(fsp, "link").mockImplementation(async (a, b) => {
      calls++;
      // call 1 is the per-directory probe; fail the next three real attempts.
      if (calls >= 2 && calls <= 4) throw Object.assign(new Error("busy"), { code: calls === 3 ? "EBUSY" : "EPERM" });
      return realLink(a, b);
    });
    await addStoryboardCard(pieceId, { id: "c0", title: "after EPERM" });
    expect(calls).toBe(5); // still on the link path — EPERM did not flip it to the fallback
    expect((await loadCard(pieceId, "c0"))?.title).toBe("after EPERM");
    expect(fs.existsSync(storyboardLockPath(pieceId))).toBe(false);
  });

  it("a temp-file cleanup failure does not fail the write or leak the lock", async () => {
    const realRm = fsp.rm.bind(fsp);
    vi.spyOn(fsp, "rm").mockImplementation(async (p, opts) => {
      if (String(p).endsWith(".tmp")) throw Object.assign(new Error("busy"), { code: "EBUSY" });
      return realRm(p, opts);
    });
    await addStoryboardCard(pieceId, { id: "c0", title: "ok" });
    expect((await loadCard(pieceId, "c0"))?.title).toBe("ok");
    expect(fs.existsSync(storyboardLockPath(pieceId))).toBe(false);
  });

  it("a release that can't remove the lock warns, and this process reclaims it next time", async () => {
    const realRm = fsp.rm.bind(fsp);
    const rm = vi.spyOn(fsp, "rm").mockImplementation(async (p, opts) => {
      if (String(p).endsWith(".lock")) throw Object.assign(new Error("locked"), { code: "EPERM" });
      return realRm(p, opts);
    });
    const warn = vi.spyOn(serverLogger, "warn");
    await addStoryboardCard(pieceId, { id: "c0", title: "first" });
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ op: "lock_release_failed" }), expect.any(String));
    expect(fs.existsSync(storyboardLockPath(pieceId))).toBe(true);
    rm.mockRestore();
    await addStoryboardCard(pieceId, { id: "c1", title: "second" });
    expect((await loadStoryboard(pieceId))?.cards).toHaveLength(2);
    expect(fs.existsSync(storyboardLockPath(pieceId))).toBe(false);
  });

  describe("staleness: liveness before age", () => {
    const writeForeignLock = (owner: object) => {
      const lockPath = storyboardLockPath(pieceId);
      fs.mkdirSync(path.dirname(lockPath), { recursive: true });
      fs.writeFileSync(lockPath, JSON.stringify(owner));
      return lockPath;
    };

    // pid 1 (init/launchd) is always alive and started at boot.
    it.skipIf(process.platform === "win32")("a live foreign pid holds the lock however old its record is", async () => {
      __setStoryboardLockTuningForTests({ staleMs: 10, acquireTimeoutMs: 150 });
      const lockPath = writeForeignLock({ pid: 1, acquiredAt: Date.now() - 60_000, nonce: "n" });
      const before = fs.readFileSync(lockPath, "utf8");
      await expect(withStoryboardLock(pieceId, () => "x")).rejects.toBeInstanceOf(StoryboardBusyError);
      expect(fs.readFileSync(lockPath, "utf8")).toBe(before);
    });

    it.skipIf(process.platform === "win32")("a live pid that started AFTER the record (pid reuse) is stale once aged", async () => {
      __setStoryboardLockTuningForTests({ staleMs: 10, acquireTimeoutMs: 2000 });
      const lockPath = writeForeignLock({ pid: 1, acquiredAt: 1000, nonce: "n" }); // 1970
      await expect(withStoryboardLock(pieceId, () => "stolen")).resolves.toBe("stolen");
      expect(fs.existsSync(lockPath)).toBe(false);
    });

    it("an unprobeable owner (another host) is stale only once aged", async () => {
      __setStoryboardLockTuningForTests({ staleMs: 5_000, acquireTimeoutMs: 100 });
      writeForeignLock({ pid: 1, host: "some-other-host", acquiredAt: Date.now(), nonce: "n" });
      await expect(withStoryboardLock(pieceId, () => "x")).rejects.toBeInstanceOf(StoryboardBusyError);
      writeForeignLock({ pid: 1, host: "some-other-host", acquiredAt: Date.now() - 10_000, nonce: "n" });
      await expect(withStoryboardLock(pieceId, () => "stolen")).resolves.toBe("stolen");
    });

    it("two waiters behind a long hold never overlap once one acquires (acquiredAt stamped at acquisition)", async () => {
      // Three module instances = three processes' in-memory state on one set of files.
      const staleMs = 20;
      const mk = async () => {
        vi.resetModules();
        const m = (await import("@/lib/storyboard/lock")) as typeof import("@/lib/storyboard/lock");
        m.__setStoryboardLockTuningForTests({ staleMs, acquireTimeoutMs: 5_000 });
        return m;
      };
      const [x, a, b] = [await mk(), await mk(), await mk()];
      let inside = 0;
      let maxInside = 0;
      const hold = (ms: number) => async () => {
        inside++;
        maxInside = Math.max(maxInside, inside);
        await new Promise((r) => setTimeout(r, ms));
        inside--;
      };
      const holder = x.withStoryboardLock(pieceId, hold(staleMs * 5)); // waiters wait >> staleMs
      await new Promise((r) => setTimeout(r, 5));
      await Promise.all([
        holder,
        a.withStoryboardLock(pieceId, hold(staleMs * 5)),
        b.withStoryboardLock(pieceId, hold(staleMs * 5)),
      ]);
      expect(maxInside).toBe(1);
    });
  });

  describe("re-review fixes", () => {
    const writeLock = (owner: object) => {
      const lockPath = storyboardLockPath(pieceId);
      fs.mkdirSync(path.dirname(lockPath), { recursive: true });
      fs.writeFileSync(lockPath, JSON.stringify(owner));
      return lockPath;
    };

    it("an undeletable stale lock backs off and ends in the busy error — no hot spin", async () => {
      __setStoryboardLockTuningForTests({ acquireTimeoutMs: 150 });
      const lockPath = writeLock({ pid: 2 ** 30, acquiredAt: Date.now(), nonce: "dead" }); // dead pid: stale
      const rename = vi.spyOn(fsp, "rename").mockRejectedValue(Object.assign(new Error("immutable"), { code: "EPERM" }));
      const started = Date.now();
      await expect(withStoryboardLock(pieceId, () => "x")).rejects.toBeInstanceOf(StoryboardBusyError);
      expect(Date.now() - started).toBeLessThan(1000);
      // 150 ms at >= 5 ms per poll is at most ~30 attempts; a hot spin does thousands.
      expect(rename.mock.calls.length).toBeGreaterThan(0);
      expect(rename.mock.calls.length).toBeLessThan(60);
      expect(fs.existsSync(lockPath)).toBe(true);
    });

    it("any record older than maxHoldMs is stale even when its pid is alive (leak / Windows pid reuse)", async () => {
      // pid 1 is alive; the clock is jumped 3 minutes past the record.
      const t0 = Date.now();
      writeLock({ pid: 1, acquiredAt: t0, nonce: "leaked" });
      __setStoryboardLockTuningForTests({ now: () => Date.now() + 3 * 60_000, acquireTimeoutMs: 2_000 });
      await expect(withStoryboardLock(pieceId, () => "reclaimed")).resolves.toBe("reclaimed");
      expect(fs.existsSync(storyboardLockPath(pieceId))).toBe(false);
    });

    it.skipIf(process.platform === "win32")("below maxHoldMs a live, un-reused pid still holds", async () => {
      writeLock({ pid: 1, acquiredAt: Date.now(), nonce: "live" });
      __setStoryboardLockTuningForTests({ now: () => Date.now() + 60_000, staleMs: 10, acquireTimeoutMs: 100 });
      await expect(withStoryboardLock(pieceId, () => "x")).rejects.toBeInstanceOf(StoryboardBusyError);
    });

    it.skipIf(process.platform === "win32")("a blocked waiter probes ps once per record, not once per poll", async () => {
      __setStoryboardLockTuningForTests({ staleMs: 10, acquireTimeoutMs: 200 });
      writeLock({ pid: 1, acquiredAt: Date.now() - 1_000, nonce: "live" }); // aged, alive, not reused
      const before = __storyboardLockStatsForTests().psSpawns;
      await expect(withStoryboardLock(pieceId, () => "x")).rejects.toBeInstanceOf(StoryboardBusyError);
      expect(__storyboardLockStatsForTests().psSpawns - before).toBe(1);
    });

    describe("permission errors", () => {
      const onLockOpen = (codeName: string) => {
        vi.spyOn(fsp, "link").mockRejectedValue(Object.assign(new Error("no links"), { code: "ENOTSUP" }));
        const realOpen = fsp.open.bind(fsp);
        vi.spyOn(fsp, "open").mockImplementation(async (p, flags, mode) => {
          if (String(p).endsWith(".lock") && flags === "wx") throw Object.assign(new Error("denied"), { code: codeName });
          return realOpen(p, flags, mode);
        });
      };

      it("EACCES on macOS/Linux (read-only data folder) is thrown at once, not reported as busy", async () => {
        __setStoryboardLockTuningForTests({ accessErrorsTransient: false });
        onLockOpen("EACCES");
        const started = Date.now();
        await expect(withStoryboardLock(pieceId, () => "x")).rejects.toMatchObject({ code: "EACCES" });
        expect(Date.now() - started).toBeLessThan(1000);
      });

      it("EPERM on Windows is retried as held until the deadline", async () => {
        __setStoryboardLockTuningForTests({ accessErrorsTransient: true, acquireTimeoutMs: 100 });
        onLockOpen("EPERM");
        await expect(withStoryboardLock(pieceId, () => "x")).rejects.toBeInstanceOf(StoryboardBusyError);
      });
    });

    it("the background release retry never runs while a new holder is inside (in-process queue)", async () => {
      __setStoryboardLockTuningForTests({ backgroundReleaseDelaysMs: [30, 30, 30] });
      const lockPath = storyboardLockPath(pieceId);
      const realRm = fsp.rm.bind(fsp);
      const rm = vi.spyOn(fsp, "rm").mockImplementation(async (p, opts) => {
        if (String(p) === lockPath) throw Object.assign(new Error("locked"), { code: "EPERM" });
        return realRm(p, opts);
      });
      await withStoryboardLock(pieceId, () => "leaks"); // release fails → background retry in 30 ms
      expect(fs.existsSync(lockPath)).toBe(true);
      rm.mockRestore();
      const realRead = fsp.readFile.bind(fsp);
      let inside = false;
      let readsWhileInside = 0;
      vi.spyOn(fsp, "readFile").mockImplementation((async (p: Parameters<typeof fsp.readFile>[0], o?: unknown) => {
        if (inside && String(p) === lockPath) readsWhileInside++;
        return realRead(p, o as never);
      }) as typeof fsp.readFile);
      // Reclaims the leaked lock (own pid, dead nonce) and holds well past the 30 ms timer.
      await withStoryboardLock(pieceId, async () => {
        inside = true;
        await new Promise((r) => setTimeout(r, 150));
        expect(fs.existsSync(lockPath)).toBe(true); // our fresh lock was not deleted
        inside = false;
      });
      expect(readsWhileInside).toBe(0);
      await new Promise((r) => setTimeout(r, 60)); // let the queued retry run: not ours any more → no-op
      expect(fs.existsSync(lockPath)).toBe(false);
    });

    // Real OS processes, not module instances: a holder blocks two waiters well
    // past staleMs; the first waiter to get in then holds past staleMs too
    // while the other still waits. Handshake-driven (stdout lines + a go file),
    // so timing on a slow CI box changes only how long it takes.
    it.skipIf(process.platform === "win32")(
      "separate processes: two waiters behind a long hold never overlap",
      async () => {
        const home = path.resolve(path.dirname(storyboardLockPath(pieceId)), "..", "..");
        const out = path.join(home, "holds.jsonl");
        const go = path.join(home, "go");
        const root = path.resolve(__dirname, "..", "..", "..");
        const tsx = path.join(root, "node_modules", "tsx", "dist", "cli.mjs");
        const child = path.join(root, "__tests__", "helpers", "storyboard-lock-child.ts");
        const run = (name: string, extra: Record<string, string>) => {
          const cp = spawn(process.execPath, [tsx, child], {
            cwd: root,
            env: { ...process.env, LIBI_HOME: home, PIECE: pieceId, NAME: name, OUT: out, STALE_MS: "50", ...extra },
            stdio: ["ignore", "pipe", "pipe"],
          });
          children.push(cp);
          let buf = "";
          const lines: string[] = [];
          const waiters: Array<[string, () => void]> = [];
          cp.stdout!.on("data", (d: Buffer) => {
            buf += d.toString();
            let i;
            while ((i = buf.indexOf("\n")) >= 0) {
              lines.push(buf.slice(0, i));
              buf = buf.slice(i + 1);
            }
            for (const [want, resolve] of waiters) if (lines.includes(want)) resolve();
          });
          let stderr = "";
          cp.stderr!.on("data", (d: Buffer) => (stderr += d.toString()));
          const exited = new Promise<number | null>((r) => cp.on("exit", (c) => r(c)));
          return {
            saw: (want: string) =>
              new Promise<void>((resolve) => (lines.includes(want) ? resolve() : waiters.push([want, resolve]))),
            exited,
            stderr: () => stderr,
          };
        };
        {
          const holder = run("H", { GO_FILE: go });
          await holder.saw("held");
          const w1 = run("W1", { HOLD_MS: "300" });
          const w2 = run("W2", { HOLD_MS: "300" });
          await Promise.all([w1.saw("waiting"), w2.saw("waiting")]);
          await new Promise((r) => setTimeout(r, 250)); // both now waiting >> staleMs
          fs.writeFileSync(go, "");
          const codes = await Promise.all([holder.exited, w1.exited, w2.exited]);
          expect(codes, `${holder.stderr()}${w1.stderr()}${w2.stderr()}`).toEqual([0, 0, 0]);
          const holds = fs
            .readFileSync(out, "utf8")
            .trim()
            .split("\n")
            .map((l) => JSON.parse(l) as { name: string; a: number; b: number })
            .sort((x, y) => x.a - y.a);
          expect(holds.map((h) => h.name)[0]).toBe("H");
          expect(holds).toHaveLength(3);
          for (let i = 1; i < holds.length; i++) expect(holds[i].a).toBeGreaterThanOrEqual(holds[i - 1].b);
          expect(fs.existsSync(storyboardLockPath(pieceId))).toBe(false);
        }
      },
      30_000,
    );
  });
});