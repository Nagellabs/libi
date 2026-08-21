/**
 * `libi.build_onboarding_piece` — the agent's single call for the first-run demo.
 *
 * Three things fail SILENTLY around this tool, and each has its own test here:
 *
 *  1. A schema imported from "zod" instead of "zod/v3" makes the SDK's
 *     JSON-schema conversion fail with no error and no warning — every tool
 *     disappears from `tools/list`.
 *
 *  2. `force: true` on its own rebuilds nothing. `force` lives in the runner's
 *     `paramsSchema`, so `{ version: "v1", force: true }` has ONE stable hash and
 *     `JobManager.enqueue` answers `matching_completed` for any terminal row with
 *     that hash. A user asking to rebuild a second time would get the first
 *     build's stored result replayed and not a single byte downloaded. The tool
 *     must pair `force` with the `forceNew` enqueue option.
 *     (`__tests__/integration/onboarding/build-piece-jobmanager.test.ts` proves the
 *     same contract from the JobManager side, on the real runner.)
 *
 *  3. A cached `matching_completed` row whose stored status was `failed` or
 *     `cancelled` reads as an empty success if the caller only looks at
 *     `.result` — the agent then tells a brand-new user the demo is ready and
 *     hands them a pieceId of `undefined`.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, it, expect, vi, beforeEach } from "vitest";

const runJobViaServer = vi.fn();
vi.mock("@/mcp/jobs-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/mcp/jobs-client")>();
  return { ...actual, runJobViaServer: (...a: unknown[]) => runJobViaServer(...a) };
});

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  buildOnboardingPiece,
  type OnboardingPieceBuildResult,
} from "@/mcp/tools/onboarding-tools";
import { createLibiMcpServer } from "@/mcp/server";
// Type-only, and only ever from a TEST file: the drift guard below needs both
// shapes in one place, and `import type` is erased before anything runs.
import type { OnboardingPieceResult } from "@/lib/jobs/runners/onboarding-piece";

const ROOT = process.cwd(); // vitest runs from the repo root
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf-8");

/** The tool as an MCP client actually sees it, via a real `tools/list`. */
async function listedTool() {
  const server = createLibiMcpServer();
  const client = new Client({ name: "test", version: "0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const { tools } = await client.listTools();
    return tools.find((t) => t.name === "libi.build_onboarding_piece");
  } finally {
    await client.close();
    await server.close();
  }
}

function completedResult(over: Record<string, unknown> = {}) {
  return {
    pieceId: "piece-onboarding-1",
    version: "v1",
    bytes: 14_796_113,
    assets: 21,
    reused: false,
    ...over,
  };
}

beforeEach(() => {
  runJobViaServer.mockReset();
});

describe("build_onboarding_piece — the silent failures", () => {
  it("declares its schema against zod/v3", () => {
    // DO NOT DELETE THIS AS REDUNDANT WITH THE tools/list TEST BELOW. It was
    // checked against the installed stack (SDK 1.29.0, zod 4.3.6): a zod-v4
    // object of exactly this shape — `.optional().describe()`, no nested
    // objects — registers and lists fine, alone or mixed with v3 tools. So the
    // round trip stays GREEN on a `"zod"` import here, and this grep is the
    // only thing guarding the repo rule for this shape. Richer schemas
    // elsewhere in schemas.ts are the ones that vanish, and they share this
    // one import line.
    const src = read("mcp/tools/schemas.ts");
    expect(src).toMatch(/from "zod\/v3"/);
    expect(src).not.toMatch(/from "zod"/);
  });

  it("does not import lib/jobs at runtime", () => {
    // A value import would drag the whole runner registry (ffmpeg, Playwright)
    // into the MCP stdio child.
    const src = read("mcp/tools/onboarding-tools.ts");
    expect(src).not.toMatch(/from "@\/lib\/jobs/);
    expect(src).not.toMatch(/from "\.\.\/\.\.\/lib\/jobs/);
  });

  it("keeps its local result shape in step with the runner's", () => {
    // The price of the rule above: `OnboardingPieceBuildResult` has no link of
    // any kind to the runner's `OnboardingPieceResult`, so a rename on the
    // runner side leaves the tool returning `undefined` for that field with
    // nothing failing — only `pieceId` is guarded at runtime. This test is the
    // link. Test files MAY import lib/jobs; the tool still may not.
    //
    // `Record<keyof …, true>` on both sides makes it bite twice: renaming a
    // key on the runner fails `tsc` on RUNNER_KEYS (missing + excess property),
    // and updating RUNNER_KEYS without updating the tool fails the assertion
    // right here.
    const RUNNER_KEYS: Record<keyof OnboardingPieceResult, true> = {
      pieceId: true,
      version: true,
      bytes: true,
      assets: true,
      reused: true,
    };
    const TOOL_KEYS: Record<keyof OnboardingPieceBuildResult, true> = {
      pieceId: true,
      version: true,
      bytes: true,
      assets: true,
      reused: true,
      // The tool's own addition, deliberately NOT on the runner: `description`
      // is derived from the definition at call time so a cache hit describes
      // the film this install would build today. A runner field would be
      // stored with the job row and would describe whichever film was current
      // when the FIRST build ran.
      description: true,
    };
    const TOOL_ONLY = new Set(["description"]);
    expect(Object.keys(TOOL_KEYS).filter((k) => !TOOL_ONLY.has(k)).sort()).toEqual(
      Object.keys(RUNNER_KEYS).sort(),
    );

    // Key sets alone would not notice `bytes: number` becoming `bytes: string`.
    // Assignability would; this line is checked by `tsc` and exists for no
    // other reason. One direction only, now that the tool result is a superset.
    const fromRunner: OnboardingPieceBuildResult = {} as OnboardingPieceResult;
    expect(Object.keys(fromRunner)).toEqual([]);
  });

  it("describes the film it built, from the definition", async () => {
    // The agent's account of the film used to come from prose in the skill —
    // a copy of facts that live in the definition, which a v2 recut would
    // silently make wrong. Derived here instead, so it versions with the film.
    const { describeOnboardingPiece } = await import("@/lib/onboarding/piece/describe");
    const { ONBOARDING_DEFINITIONS } = await import("@/lib/onboarding/piece/definitions");
    const text = describeOnboardingPiece(ONBOARDING_DEFINITIONS.v1.definition);

    // Counted off the definition, never restated: if the film is recut, these
    // move together and this test keeps passing for the right reason.
    const D = ONBOARDING_DEFINITIONS.v1.definition;
    expect(text).toContain(`${D.overlays.length} overlays`);
    expect(text).toContain(`${D.audioClips.length} audio clips`);
    // Every beat is listed, arrow-separated — catches a truncated beat list,
    // which the per-name loop below would not (it only checks presence).
    expect((text.match(/→/g) ?? []).length).toBe(D.beats.length - 1);
    // The runtime and the ducking, the two things the skill used to assert.
    expect(text).toMatch(/52s/);
    expect(text).toMatch(/2 music beds/);
    expect(text).toMatch(/6 voice-over lines/);
    // Every beat, in order.
    for (const b of D.beats) {
      const beat = b.name.replace(/^\s*SLOT\s+[A-Z]\s*[—–-]\s*/i, "");
      expect(text, b.name).toContain(beat);
    }
    // Honest about the reticle, and bounded: no ids, no paths, no user text.
    expect(text).toMatch(/pre-made animation/i);
    expect(text).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/);
    expect(text.length).toBeLessThan(1200);
  });

  it("actually appears in tools/list, with its params", async () => {
    // Asserted through a real client rather than by grepping server.ts: the
    // zod-v4 failure above is a CONVERSION failure, so the only proof that it
    // hasn't happened is the tool surviving the round trip. The runner
    // declares this exact name as its `mcpToolId`; a different one silently
    // unhooks the chat progress bridge.
    const tool = await listedTool();
    expect(tool).toBeDefined();
    expect(Object.keys(tool!.inputSchema.properties ?? {}).sort()).toEqual([
      "force",
      "version",
    ]);
  });

  it("tells the agent the download size and that it is onboarding-only", async () => {
    // Agent-facing copy: this description is the entire basis on which the
    // agent decides whether calling it is appropriate.
    const tool = await listedTool();
    expect(tool!.description).toMatch(/~15 MB/);
    expect(tool!.description).toMatch(/ONBOARDING ONLY/);
  });
});

describe("build_onboarding_piece — enqueue contract", () => {
  it("defaults to v1 and force:false, and does NOT force a new job", async () => {
    runJobViaServer.mockResolvedValue({
      status: "new",
      jobId: "job-1",
      clientKey: "ck",
      result: completedResult(),
    });

    await buildOnboardingPiece({});

    expect(runJobViaServer).toHaveBeenCalledTimes(1);
    const [kind, params, opts] = runJobViaServer.mock.calls[0];
    expect(kind).toBe("onboarding_piece");
    expect(params).toEqual({ version: "v1", force: false });
    expect(opts.forceNew).toBe(false);
  });

  it("pairs force:true with forceNew:true so a rebuild really rebuilds", async () => {
    runJobViaServer.mockResolvedValue({
      status: "new",
      jobId: "job-2",
      clientKey: "ck",
      forced: true,
      result: completedResult({ pieceId: "piece-onboarding-2" }),
    });

    await buildOnboardingPiece({ force: true });

    const [, params, opts] = runJobViaServer.mock.calls[0];
    expect(params).toEqual({ version: "v1", force: true });
    // Without this, the second forced call replays the first job's result and
    // downloads nothing at all.
    expect(opts.forceNew).toBe(true);
  });

  it("forwards the MCP extra so job progress reaches the client", async () => {
    runJobViaServer.mockResolvedValue({
      status: "new",
      jobId: "job-3",
      clientKey: "ck",
      result: completedResult(),
    });

    const extra = { _meta: { progressToken: "tok" } };
    await buildOnboardingPiece({}, extra as never);

    expect(runJobViaServer.mock.calls[0][2].extra).toBe(extra);
  });
});

describe("build_onboarding_piece — results", () => {
  it("returns the piece on the happy path", async () => {
    runJobViaServer.mockResolvedValue({
      status: "new",
      jobId: "job-1",
      clientKey: "ck",
      result: completedResult(),
    });

    const r = await buildOnboardingPiece({});
    expect(r.success).toBe(true);
    expect(r.data.pieceId).toBe("piece-onboarding-1");
    expect(r.data.assets).toBe(21);
    expect(r.data.reused).toBe(false);
  });

  it("returns the cached piece, and does not claim this call downloaded it", async () => {
    // The realistic stored row, not a convenient one: on the ordinary repeat
    // path the runner never executes, so its `reused: true, bytes: 0` branch
    // never executes either and what is cached is the FIRST run's JSON —
    // `reused: false`, the full 14,796,113 bytes, 21 assets. Passing that
    // through tells the agent it just downloaded 15 MB, and the agent tells
    // the user, who waited on nothing.
    runJobViaServer.mockResolvedValue({
      status: "matching_completed",
      existingJob: {
        jobId: "job-old",
        pieceId: "piece-onboarding-1",
        completedAt: "2026-08-20T00:00:00.000Z",
        status: "completed",
        result: completedResult(),
      },
    });

    const r = await buildOnboardingPiece({});
    // Facts about the piece survive a cache hit…
    expect(r.data.pieceId).toBe("piece-onboarding-1");
    expect(r.data.version).toBe("v1");
    // …facts about THIS call's work are corrected.
    expect(r.data.reused).toBe(true);
    expect(r.data.bytes).toBe(0);
    expect(r.data.assets).toBe(0);
  });

  it("surfaces a cached FAILED job as an error, not a success", async () => {
    runJobViaServer.mockResolvedValue({
      status: "matching_completed",
      existingJob: {
        jobId: "job-old",
        pieceId: null,
        completedAt: "2026-08-20T00:00:00.000Z",
        status: "failed",
        error: "onboarding: asset logo-mark.png failed: sha256 mismatch",
      },
    });

    await expect(buildOnboardingPiece({})).rejects.toThrow(/sha256 mismatch/);
  });

  it("surfaces a cached CANCELLED job as an error", async () => {
    runJobViaServer.mockResolvedValue({
      status: "matching_completed",
      existingJob: {
        jobId: "job-old",
        pieceId: null,
        completedAt: "2026-08-20T00:00:00.000Z",
        status: "cancelled",
        error: null,
      },
    });

    // A cancelled row stores no `error`, so this message is the whole of what
    // the agent gets. It names the state and what a new build would require —
    // and stops there. See the no-imperative test below.
    await expect(buildOnboardingPiece({})).rejects.toThrow(/cancelled/);
    await expect(buildOnboardingPiece({})).rejects.toThrow(/requires force: true/);
  });

  it("states what happened without telling the agent to retry", async () => {
    // These strings land in the agent's tool-result mid-turn, and the
    // onboarding skill that drives this tool says, in as many words: "Do not
    // retry. Not once, not 'just in case', not with `force`." A tool that
    // hands the agent an imperative is competing with the skill for control of
    // the turn, on the one path where a brand-new user is already having a bad
    // first minute. Policy lives in the skill; the tool describes state.
    const terminal = (over: Record<string, unknown>) => ({
      status: "matching_completed",
      existingJob: {
        jobId: "job-old",
        pieceId: null,
        completedAt: "2026-08-20T00:00:00.000Z",
        error: null,
        ...over,
      },
    });

    for (const resp of [
      terminal({ status: "cancelled" }),
      terminal({ status: "failed" }),
      terminal({ status: "completed" }), // no `result` — the no-result path
    ]) {
      runJobViaServer.mockResolvedValue(resp);
      const err = await buildOnboardingPiece({}).catch((e: Error) => e);
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).not.toMatch(/\bretry\b/i);
      expect((err as Error).message).not.toMatch(/\btry again\b/i);
      // …while still carrying the fact the agent would need if its skill did
      // permit another build.
      expect((err as Error).message).toMatch(/force: true/);
    }
  });

  it("refuses to report success when a terminal job carried no result", async () => {
    // An empty success here would hand the agent `pieceId: undefined` and it
    // would cheerfully tell the user the demo is ready.
    runJobViaServer.mockResolvedValue({
      status: "matching_completed",
      existingJob: {
        jobId: "job-old",
        pieceId: null,
        completedAt: "2026-08-20T00:00:00.000Z",
        status: "completed",
      },
    });

    await expect(buildOnboardingPiece({})).rejects.toThrow(/without a usable result/);
  });
});

describe("a cached build that names a deleted piece", () => {
  /**
   * THE DEAD END, observed live on 2026-08-20.
   *
   * `JobManager.enqueue` answers `matching_completed` from the params hash
   * alone, BEFORE the runner is entered — so the runner's own
   * `findExistingPiece` guard, which DOES check the piece exists and carries a
   * manifest, never gets a say. Delete the demo piece and press "Show me how
   * it works" again: the tool hands the agent a pieceId that resolves to
   * nothing, `show_piece` navigates nowhere, no error is raised, and it stays
   * broken for every future press. The user's only escape is a `force` flag
   * they have no way to know about.
   *
   * `pieceExists` is injected here rather than mocked at the DB layer on
   * purpose: the real check fails OPEN (a DB read error must not take the demo
   * down), so a test without a schema silently exercises the fail-open branch
   * and passes while guarding nothing. That happened on the first attempt.
   */
  const DELETED = "00000000-0000-4000-8000-000000000000";
  const FRESH = "11111111-1111-4111-8111-111111111111";
  const cachedHit = (pieceId: string) => ({
    status: "matching_completed",
    existingJob: {
      jobId: "job-old",
      status: "completed",
      result: { pieceId, version: "v1", bytes: 14_796_113, assets: 21, reused: false },
    },
  });

  it("rebuilds rather than handing back an id that no longer resolves", async () => {
    runJobViaServer
      .mockResolvedValueOnce(cachedHit(DELETED))
      .mockResolvedValueOnce({
        status: "new",
        result: { pieceId: FRESH, version: "v1", bytes: 14_796_113, assets: 21, reused: false },
      });

    const r = await buildOnboardingPiece({ version: "v1" }, undefined, {
      pieceExists: () => false,
    });

    expect(r.data.pieceId).toBe(FRESH);
    expect(runJobViaServer).toHaveBeenCalledTimes(2);
    // The rebuild must carry `forceNew`, or JobManager replays the very row we
    // just rejected and we are back where we started.
    expect((runJobViaServer.mock.calls[1][2] as { forceNew?: boolean }).forceNew).toBe(true);
  });

  it("leaves an ordinary cache hit alone when the piece is still there", async () => {
    // The guard must not turn every repeat press into a fresh 15 MB download.
    runJobViaServer.mockResolvedValueOnce(cachedHit(FRESH));

    const r = await buildOnboardingPiece({ version: "v1" }, undefined, {
      pieceExists: () => true,
    });

    expect(r.data.pieceId).toBe(FRESH);
    expect(r.data.reused).toBe(true);
    expect(r.data.bytes).toBe(0);
    expect(runJobViaServer).toHaveBeenCalledTimes(1);
  });
});

