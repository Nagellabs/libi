// A storyboard lock timeout (StoryboardBusyError) must reach callers as a clear,
// retryable status — HTTP 409 from the routes, an isError tool result that says
// it is safe to retry from MCP — never a bare 500 / generic failure.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createTempStorageDir, cleanupTempDir } from "@/__tests__/helpers/test-storage";
import { createTestDb, resetTestDb } from "@/__tests__/helpers/test-db";
import { pieces } from "@/lib/db/schema/sqlite";
import { saveManifest } from "@/lib/composition/persistence";
import { saveCurrentSnapshot, listSnapshotHistory } from "@/lib/composition/snapshots";
import { commitDraftTool, discardDraftTool } from "@/mcp/tools/snapshot-tools";
import { POST as commitRoute } from "@/app/api/pieces/[pieceId]/snapshot/commit/route";
import { resetStorage } from "@/lib/storage";
import {
  withStoryboardLock,
  StoryboardBusyError,
  STORYBOARD_BUSY_MESSAGE,
  STORYBOARD_BUSY_PARTIAL_MESSAGE,
  __setStoryboardLockTuningForTests,
} from "@/lib/storyboard/lock";
import { storyboardBusyResponse, withStoryboardBusy } from "@/lib/storyboard/busy-response";
import { makeError } from "@/mcp/tool-error";
import { addStoryboardCard as addCardTool } from "@/mcp/tools/storyboard-tools";
import { PATCH as patchCard } from "@/app/api/pieces/[pieceId]/storyboard/cards/[cardId]/route";
import { addStoryboardCard } from "@/lib/storyboard/repo";

const pieceId = "piece_busy";

describe("StoryboardBusyError mapping", () => {
  beforeEach(() => {
    createTempStorageDir();
    resetStorage();
    __setStoryboardLockTuningForTests();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    __setStoryboardLockTuningForTests();
    cleanupTempDir();
    resetStorage();
  });

  it("HTTP: busy → 409 with the retry message; anything else → untouched", async () => {
    const res = storyboardBusyResponse(new StoryboardBusyError());
    expect(res?.status).toBe(409);
    expect(await res?.json()).toEqual({ error: STORYBOARD_BUSY_MESSAGE, retryable: true, partial: false });
    expect(storyboardBusyResponse(new Error("other"))).toBeNull();
    const boom = withStoryboardBusy(async () => {
      throw new Error("other");
    });
    await expect(boom()).rejects.toThrow("other");
  });

  it("MCP: busy → isError result that says it is safe to retry; other errors keep their message", () => {
    const busy = makeError(new StoryboardBusyError());
    expect(busy.isError).toBe(true);
    const body = JSON.parse(busy.content[0].text);
    expect(body).toMatchObject({ success: false, retryable: true });
    expect(body.error).toContain(STORYBOARD_BUSY_MESSAGE);
    expect(body.error).toContain("Safe to retry");
    expect(JSON.parse(makeError(new Error("nope")).content[0].text)).toEqual({ success: false, error: "nope" });
  });

  describe("end to end, behind a held lock", () => {
    let release!: () => void;
    let holder: Promise<unknown>;
    beforeEach(async () => {
      await addStoryboardCard(pieceId, { id: "c0", title: "t" });
      __setStoryboardLockTuningForTests({ acquireTimeoutMs: 60 });
      holder = withStoryboardLock(pieceId, () => new Promise<void>((r) => { release = r; }));
    });
    afterEach(async () => {
      release();
      await holder;
    });

    it("a storyboard route answers 409", async () => {
      const req = new Request("http://x/api", { method: "PATCH", body: JSON.stringify({ title: "new" }) });
      const res = await patchCard(req, { params: Promise.resolve({ pieceId, cardId: "c0" }) });
      expect(res.status).toBe(409);
      expect((await res.json()).error).toBe(STORYBOARD_BUSY_MESSAGE);
    });

    it("the add_storyboard_card tool lets the busy error reach makeError (not a plain failure)", async () => {
      await expect(addCardTool({ pieceId, card: { title: "x" } }, { pieceId })).rejects.toBeInstanceOf(StoryboardBusyError);
    });
  });

  it("a PARTIAL busy error (commit/discard draft) is not 'safe to retry' on either surface", async () => {
    const partial = new StoryboardBusyError({ partial: true });
    const res = storyboardBusyResponse(partial);
    expect(res?.status).toBe(409);
    expect(await res?.json()).toEqual({ error: STORYBOARD_BUSY_PARTIAL_MESSAGE, retryable: false, partial: true });
    const body = JSON.parse(makeError(partial).content[0].text);
    expect(body).toMatchObject({ success: false, retryable: false, partial: true });
    expect(body.error).toContain("libi.get_piece_state");
    expect(body.error).not.toContain("Safe to retry");
  });

  describe("commit_draft / discard_draft behind a held storyboard lock", () => {
    let release!: () => void;
    let holder: Promise<unknown>;
    let pid: string;
    const manifest = (name: string) => ({
      width: 1920, height: 1080, fps: 30,
      overlays: [{ id: "code-s1", kind: "code" as const, displayName: name, startTime: 0, duration: 1, z: 0, rect: { x: 0, y: 0, width: 1920, height: 1080 }, opacity: 1, drawFunction: "" }],
    });
    beforeEach(async () => {
      const db = createTestDb();
      const [piece] = await db.insert(pieces).values({ name: "p", hasDraft: true, snapshotSummary: "v1" }).returning();
      pid = piece.id;
      await saveCurrentSnapshot(pid, manifest("v1"));
      await saveManifest(pid, manifest("v2"));
      __setStoryboardLockTuningForTests({ acquireTimeoutMs: 60 });
      holder = withStoryboardLock(pid, () => new Promise<void>((r) => { release = r; }));
    });
    afterEach(async () => {
      release();
      await holder;
      resetTestDb();
    });

    it("the MCP commit tool raises a partial busy error — and the composition step really did land", async () => {
      const err = await commitDraftTool({ pieceId: pid, summary: "v2" } as never).catch((e) => e);
      expect(err).toBeInstanceOf(StoryboardBusyError);
      expect(err.partial).toBe(true);
      // Why it is not a clean retry: the old snapshot was already pushed to history.
      expect((await listSnapshotHistory(pid)).length).toBe(1);
      expect(JSON.parse(makeError(err).content[0].text).retryable).toBe(false);
    });

    it("the MCP discard tool raises a partial busy error", async () => {
      const err = await discardDraftTool({ pieceId: pid, confirm: true } as never).catch((e) => e);
      expect(err).toBeInstanceOf(StoryboardBusyError);
      expect(err.partial).toBe(true);
    });

    it("the commit route answers 409 with retryable:false", async () => {
      const req = new Request("http://x/api", { method: "POST", body: JSON.stringify({ summary: "v2" }) });
      const res = await commitRoute(req, { params: Promise.resolve({ pieceId: pid }) });
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ retryable: false, partial: true, error: STORYBOARD_BUSY_PARTIAL_MESSAGE });
    });
  });
});
