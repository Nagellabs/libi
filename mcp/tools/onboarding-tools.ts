import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol";
import type { ServerRequest, ServerNotification } from "@modelcontextprotocol/sdk/types";
import { notify } from "@/mcp/notify";
import { runJobViaServer } from "@/mcp/jobs-client";
import { mcpLogger as logger } from "@/lib/logger";
import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { pieces } from "@/lib/db/schema/sqlite";
import { describeOnboardingPiece } from "@/lib/onboarding/piece/describe";
import {
  DEFAULT_ONBOARDING_VERSION,
  ONBOARDING_DEFINITIONS,
} from "@/lib/onboarding/piece/definitions";
import type { ToolResult } from "./types";
import type {
  StartOnboardingParams,
  ShowApiConfigParams,
  BuildOnboardingPieceParams,
} from "./schemas";

/**
 * Re-open the onboarding panel in the right region.
 */
export async function startOnboarding(_params: StartOnboardingParams): Promise<ToolResult> {
  notify.rightRegion({ mode: "onboarding" });
  return { success: true, data: { opened: "onboarding" } };
}

/**
 * Open the inline API-key config panel for a bundled MCP.
 */
export async function showApiConfig(params: ShowApiConfigParams): Promise<ToolResult> {
  notify.rightRegion({ mode: "api-config", mcpId: params.mcpId });
  return { success: true, data: { opened: "api-config", mcpId: params.mcpId } };
}

/**
 * Result of the `onboarding_piece` job.
 *
 * Declared HERE rather than imported from `lib/jobs/runners/onboarding-piece`
 * on purpose: nothing under `mcp/` may reach into `lib/jobs/*`. Even a
 * type-only import leaves an edge in the graph that a later refactor turns
 * into a value import, and that one line would drag the whole runner registry
 * — ffmpeg, Playwright, the tracking sidecar — into the MCP stdio child. The
 * runner is the owner of this shape; the wire between them is the JSON that
 * crosses `/api/jobs`, which is exactly what this interface describes.
 */
export interface OnboardingPieceBuildResult {
  pieceId: string;
  version: string;
  /** Bytes downloaded. 0 when an existing build was reused. */
  bytes: number;
  /** Assets downloaded. 0 when an existing build was reused. */
  assets: number;
  reused: boolean;
  /** What the film IS — runtime, beats, layer counts, how the audio is mixed.
   *  Derived from the definition on every call (see `describeOnboardingPiece`),
   *  never stored, so a cache hit describes the film this install would build
   *  today rather than the one the first build produced. */
  description?: string;
}

/** Does this piece still exist? A cached job result names a pieceId that was
 *  true when the job ran; the row can be gone by the time it is replayed. */
function pieceExists(pieceId: string): boolean {
  try {
    return (
      getDb().select({ id: pieces.id }).from(pieces).where(eq(pieces.id, pieceId)).all()
        .length > 0
    );
  } catch (err) {
    // A DB read failing here must not take the demo down with it. Treat the
    // piece as present and let the normal path proceed: the worst case is the
    // pre-existing behaviour, not a new failure mode.
    logger.warn(
      { tag: "onboarding", op: "piece_exists_check_failed", pieceId, err },
      "onboarding: could not verify cached piece still exists",
    );
    return true;
  }
}

/**
 * Build libi's own 52-second film into a real piece — the first-run demo.
 *
 * Runs the `onboarding_piece` job through the HTTP client so the MCP child
 * never loads runner code. Two details are load-bearing:
 *
 * FORCE MUST BE PAIRED WITH `forceNew`. `force` sits in the runner's
 * `paramsSchema`, so `{ version, force: true }` hashes to ONE stable value and
 * `JobManager.enqueue` answers `matching_completed` for any terminal row
 * carrying that hash. Sending `force: true` alone therefore replays the FIRST
 * forced build's stored result and downloads nothing — the user asks for a
 * fresh copy twice and gets the same piece back, silently. Passing `forceNew`
 * alongside is what makes the second rebuild a rebuild.
 *
 * A CACHE HIT MUST NOT REPORT THE FIRST RUN'S DOWNLOAD AS THIS ONE'S. On the
 * ordinary repeat path — `force: false`, a good build already on disk — the
 * runner never executes, so its own `reused: true, bytes: 0` branch never
 * executes either. What comes back is the FIRST run's stored JSON, which says
 * `reused: false, bytes: 14796113, assets: 21`. Handed to the agent unaltered,
 * that becomes "downloaded 15 MB" said to a user who waited on nothing. The
 * cached counts are corrected below; only `pieceId` and `version` survive a
 * cache hit as facts about this call.
 *
 * A TERMINAL-FAILED CACHE HIT IS AN ERROR, NOT AN EMPTY SUCCESS. A cached row
 * may be `failed` or `cancelled`; reading `.result` off it yields `undefined`
 * and the agent would tell a brand-new user their demo is ready. Branch on
 * `existingJob.status` first — the same guard `importRemoteFiles` carries.
 *
 * THE ERROR TEXT DESCRIBES THE STATE; IT NEVER PRESCRIBES THE ACTION. These
 * strings land in the agent's tool-result mid-turn, so an imperative here
 * ("retry with force: true") is a competing instruction — and the onboarding
 * skill that drives this tool says the opposite in as many words: "Do not
 * retry. Not once, not 'just in case', not with `force`." Policy lives in the
 * skill. So: name what happened, note that a new build requires `force: true`,
 * and stop there.
 *
 * Defense in depth rather than the last line: a forced call cannot receive
 * `matching_completed` at all (`forceNew` discards the matching row), and on a
 * non-forced call `jobs-client.ts` already auto-escapes a failed/cancelled row
 * by re-enqueueing once. This branch is what keeps the tool correct if either
 * of those ever narrows.
 *
 * THE RESULT SAYS WHAT WAS BUILT. `pieceId` + byte counts describe the CALL;
 * they say nothing about the film, so the agent's account of it came from
 * prose in the onboarding skill — a copy of facts that live in the definition,
 * and one that would keep describing v1 after v2 shipped. `description` is
 * derived from the definition here, on every call including a cache hit, so
 * the agent relays the film it actually has.
 */
/** Seam for the cached-pieceId guard. Injectable so the guard can be tested
 *  without standing up a schema — the check's own fail-open (a DB error must
 *  not take the demo down) otherwise swallows every assertion and the test
 *  passes while guarding nothing. */
export interface BuildOnboardingDeps {
  pieceExists(pieceId: string): boolean;
}

export async function buildOnboardingPiece(
  params: BuildOnboardingPieceParams,
  extra?: RequestHandlerExtra<ServerRequest, ServerNotification>,
  deps: BuildOnboardingDeps = { pieceExists },
): Promise<{ success: true; data: OnboardingPieceBuildResult }> {
  const version = params.version ?? DEFAULT_ONBOARDING_VERSION;
  const force = params.force ?? false;

  const resp = await runJobViaServer<OnboardingPieceBuildResult>(
    "onboarding_piece",
    { version, force },
    { extra, pieceId: null, forceNew: force },
  );

  let result: OnboardingPieceBuildResult | undefined;

  if (resp.status === "matching_completed") {
    const { existingJob } = resp;
    if (existingJob.status === "failed" || existingJob.status === "cancelled") {
      throw new Error(
        existingJob.error ??
          `onboarding: the previous build of ${version} was ${existingJob.status}; ` +
            `a new build requires force: true.`,
      );
    }
    // Nothing was downloaded on THIS call, whatever the stored row says.
    result = existingJob.result && {
      ...existingJob.result,
      reused: true,
      bytes: 0,
      assets: 0,
    };

    // A CACHED pieceId IS A CLAIM ABOUT THE PAST, NOT THE PRESENT. The piece it
    // names may have been deleted since — and `JobManager.enqueue` answers
    // `matching_completed` off the params hash alone, BEFORE the runner is
    // entered, so the runner's own `findExistingPiece` guard (which does check
    // the piece exists and carries a manifest) never gets a say.
    //
    // Left unchecked this is a dead end a user cannot escape: delete the demo
    // piece, press "Show me how it works" again, and the tool hands the agent a
    // pieceId that resolves to nothing. `show_piece` navigates nowhere, no error
    // is raised, and it stays broken for every future press. Observed exactly
    // that way on 2026-08-20 after the demo piece was deleted.
    //
    // Rebuild instead of failing: the user asked for the demo, and the reason
    // their request cannot be served from cache is our bookkeeping, not
    // anything they did.
    if (result?.pieceId && !deps.pieceExists(result.pieceId)) {
      logger.info(
        {
          tag: "onboarding",
          op: "cached_piece_missing",
          version,
          jobId: existingJob.jobId,
        },
        "onboarding: cached build names a deleted piece — rebuilding",
      );
      const rebuilt = await runJobViaServer<OnboardingPieceBuildResult>(
        "onboarding_piece",
        { version, force },
        { extra, pieceId: null, forceNew: true },
      );
      result = rebuilt.status === "matching_completed" ? undefined : rebuilt.result;
    }
  } else {
    result = resp.result;
  }

  if (!result?.pieceId) {
    throw new Error(
      `onboarding: a previous build of ${version} completed without a usable result; ` +
        `a new build requires force: true.`,
    );
  }

  // Derived, never stored. A cache hit replays the FIRST build's stored JSON,
  // which was written against whatever definition shipped then; describing the
  // film from the definition this install holds now is the only version of
  // this that cannot go stale. Absent for an unknown version rather than
  // invented — the runner has already refused one of those.
  const description = ONBOARDING_DEFINITIONS[version]
    ? describeOnboardingPiece(ONBOARDING_DEFINITIONS[version].definition)
    : undefined;

  logger.info(
    {
      tag: "onboarding",
      op: "build_tool_done",
      version,
      force,
      pieceId: result.pieceId,
      reused: result.reused,
      bytes: result.bytes,
      assets: result.assets,
    },
    "onboarding.build_tool_done",
  );

  return { success: true, data: { ...result, description } };
}
