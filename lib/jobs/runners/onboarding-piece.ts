import { z } from "zod/v3";
import { desc, eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { pieces } from "@/lib/db/schema/sqlite";
import { makeMcpToolId } from "@/lib/agents/mcp-tool-id";
import { serverLogger as logger } from "@/lib/logger";
import { CancelledError, type JobContext, type JobRunner } from "@/lib/jobs/types";
import { createPiece } from "@/mcp/tools/piece-discovery-tools";
import { deletePieceCompletely } from "@/lib/pieces/delete-piece";
import { fetchAndStoreRemoteFile } from "@/lib/net/fetch-and-store";
import { assetUrl, resolveAssetSource } from "@/lib/onboarding/piece/asset-base";
import { ONBOARDING_DEFINITIONS } from "@/lib/onboarding/piece/definitions";
import {
  hasManifest,
  saveManifest,
  type CompositionManifest,
  type PersistedAudioClip,
  type PersistedOverlay,
} from "@/lib/composition/persistence";
import { trackServerEvent } from "@/lib/analytics/server";

/**
 * Build libi's own 52-second film into a real piece: download its 21 media
 * assets, verify each against the sha256 pinned in `assets.ts`, mint local
 * fileIds, rewrite the portable definition against them, and write the result
 * through the ordinary persistence seams.
 *
 * Two properties are load-bearing and everything else in this file serves them.
 *
 * ROLLBACK. This is a brand-new user's first two minutes. If the network drops
 * at asset 14 of 21, what they get must be a clear "the demo could not be
 * downloaded" and an otherwise clean slate — never a half-built piece they can
 * neither escape nor make sense of. So the whole build after `createPiece` sits
 * in one try/catch whose handler deletes the piece and rethrows the ORIGINAL
 * error. A cancel counts as a failure. Deliberately not a `finally`: that would
 * also run on the success path.
 *
 * DEDUPE ON NOTHING VOLATILE. `paramsSchema` is `{ version, force }` and nothing
 * else, because JobManager dedupes by `(kind, paramsHash)` — a timestamp, a
 * toolCallId or a pieceId in params would make every call a cache miss and
 * re-download 14.8 MB. `force` is in params on purpose, against the general
 * advice on `JobContext.forced`: that advice is about two jobs racing for ONE
 * output, and here a forced build deliberately produces a SEPARATE piece, so
 * the two hashes describe two genuinely different outputs.
 *
 * NO IDENTITY COMES OUT OF THE DEFINITION. The definition is portable data
 * shipped to every install, so every id in it that would name a row in THIS
 * machine's database is a slug, and this runner mints the local identity —
 * `assetSlug` → `fileId`, and nothing else. There used to be a second such
 * rewrite for object tracks; the film no longer ships one. Slot D's reticle is
 * a plain code overlay with its boxes baked in (see
 * `OnboardingPieceDefinition`), so there is no `tracks` sidecar to write, no
 * `tracks` row to insert, and no track id to mint.
 */

/** Marker written into `pieces.description` so a rebuild can recognise its own
 *  work. Never the NAME: the user can rename a piece, and an onboarding demo
 *  they retitled is still the demo.
 *
 *  Written LAST, only after `saveManifest` has succeeded. See
 *  {@link provisionalDescription}. */
export function onboardingMarker(version: string): string {
  return `libi:onboarding:${version}`;
}

/**
 * What the piece carries WHILE it is being built.
 *
 * The marker cannot be stamped at creation time. The `try/catch` rollback
 * covers a thrown failure, but nothing in this process covers the user quitting
 * the app mid-download, an OOM, or the machine losing power — and what those
 * leave behind is a marked, half-built piece that every later `force: false`
 * build then happily returns as `reused: true`. On a first-run demo that is the
 * worst available outcome: the user is handed the exact broken artifact the
 * rollback exists to prevent, with no way out unless they know to pass `force`.
 *
 * So the piece is born provisional and is promoted to the marker only once the
 * manifest is on disk. A killed build leaves an unmarked orphan, and the next
 * build makes a working demo.
 */
export function provisionalDescription(version: string): string {
  return `libi:onboarding:${version}:building`;
}

const onboardingPieceParamsSchema = z.object({
  version: z.literal("v1"),
  force: z.boolean(),
});

export interface OnboardingPieceParams {
  version: "v1";
  force: boolean;
}

export interface OnboardingPieceResult {
  pieceId: string;
  version: string;
  bytes: number;
  assets: number;
  reused: boolean;
}

/**
 * Deep-copy `value`, replacing every `assetSlug` with the local `fileId` the
 * download minted for it. One recursive walk rather than per-shape handlers
 * because a slug sits at more than one depth — on an overlay, on an audio
 * clip, and inside nested content — and a hand-written visitor is exactly the
 * thing that silently misses the deepest one when a shape changes.
 *
 * An unresolved slug throws. A definition referring to media that was never
 * downloaded is a build error, not a missing-asset placeholder to render.
 */
function resolveSlugs<T>(value: T, fileIdBySlug: ReadonlyMap<string, string>): T {
  if (Array.isArray(value)) {
    return value.map((v) => resolveSlugs(v, fileIdBySlug)) as unknown as T;
  }
  if (value !== null && typeof value === "object") {
    // Both keys on one node would make JS object key order decide which
    // `fileId` wins — a silent, ordering-dependent corruption. No such node
    // exists in the definition today (the whole point of `assetSlug` is to
    // REPLACE `fileId`), so say so out loud rather than letting iteration
    // order arbitrate if one ever appears.
    if (Object.hasOwn(value, "assetSlug") && Object.hasOwn(value, "fileId")) {
      throw new Error(
        `onboarding: node carries both assetSlug and fileId — ` +
          `${JSON.stringify(value)} — refusing to let key order pick a winner.`,
      );
    }
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (key !== "assetSlug") {
        out[key] = resolveSlugs(child, fileIdBySlug);
        continue;
      }
      if (typeof child !== "string") {
        throw new Error(`onboarding: assetSlug must be a string, got ${JSON.stringify(child)}`);
      }
      const fileId = fileIdBySlug.get(child);
      if (!fileId) {
        throw new Error(
          `onboarding: unresolved asset slug ${JSON.stringify(child)} — ` +
            `it is referenced by the composition but was never downloaded.`,
        );
      }
      out.fileId = fileId;
    }
    return out as unknown as T;
  }
  return value;
}

/**
 * The already-built piece for this version, or null.
 *
 * NEWEST first. `force` exists precisely for "the current one is bad, make me a
 * new one", so after a forced rebuild there are two marked pieces and the one
 * the user asked for is the newer. Returning the oldest would silently hand
 * back the stale piece they had just rejected. `desc(createdAt), desc(id)` is
 * exactly as deterministic as the other direction — `createdAt` has
 * second granularity, so the id is a real tiebreak, not decoration.
 *
 * A candidate must also HAVE a manifest. The provisional description already
 * keeps a killed build from being marked, and this is the second lock on the
 * same door: whatever the reason a marked piece has no composition — a future
 * caller stamping the marker itself, a build interrupted between the two
 * writes — it is not a demo and must not be handed to a new user as one.
 */
async function findExistingPiece(version: string): Promise<string | null> {
  const marker = onboardingMarker(version);
  const rows = getDb()
    .select({ id: pieces.id })
    .from(pieces)
    .where(eq(pieces.description, marker))
    .orderBy(desc(pieces.createdAt), desc(pieces.id))
    .all();
  for (const row of rows) {
    if (await hasManifest(row.id)) return row.id;
  }
  return null;
}

export const onboardingPieceRunner: JobRunner<OnboardingPieceParams, OnboardingPieceResult> = {
  kind: "onboarding_piece",
  // One at a time. Two concurrent builds would download the same 14.8 MB twice
  // and race each other's marker lookup.
  maxConcurrent: 1,
  paramsSchema: onboardingPieceParamsSchema as unknown as z.ZodSchema<OnboardingPieceParams>,
  // A half-downloaded piece must roll back, not resume into a state where some
  // overlays point at files and some point at nothing.
  resumable: false,
  noProgressTimeoutMs: 120_000,
  mcpToolId: makeMcpToolId("libi", "libi.build_onboarding_piece"),

  async run(ctx: JobContext<OnboardingPieceParams>): Promise<OnboardingPieceResult> {
    const { version, force } = ctx.params;
    const entry = ONBOARDING_DEFINITIONS[version];
    if (!entry) throw new Error(`onboarding: no definition for version ${version}`);
    const { definition, assets } = entry;

    if (!force) {
      const existing = await findExistingPiece(version);
      if (existing) {
        logger.info(
          { tag: "onboarding", op: "reused", version, pieceId: existing },
          "onboarding: demo piece already built — reusing it",
        );
        ctx.reportProgress(assets.length, assets.length, "files");
        return { pieceId: existing, version, bytes: 0, assets: 0, reused: true };
      }
    }

    const source = resolveAssetSource(version);
    // An install pulling its first-run demo from a non-default host deserves a
    // line in the log — this is the only place that fact is observable.
    logger.info(
      {
        tag: "onboarding",
        op: "asset_source",
        version,
        baseUrl: source.baseUrl,
        overridden: source.overridden,
        assets: assets.length,
      },
      "onboarding: resolved demo asset base",
    );

    // Provisional, NOT the marker — see `provisionalDescription`. Promoted
    // after `saveManifest`, so a process killed anywhere before that leaves
    // something the next build ignores rather than reuses.
    const created = await createPiece({
      name: definition.name,
      description: provisionalDescription(version),
    });
    if (!created.success || !created.data) {
      throw new Error(`onboarding: could not create the demo piece: ${created.error ?? "unknown"}`);
    }
    const pieceId = (created.data as { id: string }).id;

    let result: OnboardingPieceResult;
    try {
      ctx.reportProgress(0, assets.length, "files");
      const fileIdBySlug = new Map<string, string>();
      let bytes = 0;

      for (const [index, asset] of assets.entries()) {
        if (ctx.shouldCancel()) throw new CancelledError(ctx.jobId);
        try {
          const stored = await fetchAndStoreRemoteFile({
            url: assetUrl(source, asset.slug),
            // Straight through from the resolver. The guard is chosen where the
            // base is chosen and nowhere else — see `asset-base.ts`.
            guard: source.guard,
            pieceId,
            filename: asset.slug,
            expectSha256: asset.sha256,
            // The definition's own content type, not the bucket's header. The
            // bytes are sha-pinned, so their media type is a fact of the
            // definition; trusting a header that says
            // `application/octet-stream` files every clip as type "other",
            // which skips the ffprobe pass — leaving the video overlays with
            // no source dimensions, which is exactly what a tracked overlay
            // maps its track boxes into the composition with.
            contentType: asset.contentType,
            // No proxies for this piece. Now that the clips land as
            // `type: "video"` (above), `storeFile` would enqueue `proxy_gen`
            // for all three — and the hazard is not the CPU. On completion the
            // runner emits `refresh_query`, `buildComposition` re-runs,
            // `pickVideoUrl` switches to the proxy and three overlays change
            // `videoUrl` — plausibly mid-playback of the film a brand-new user
            // is watching for the first time. The upside is close to nil: the
            // onboarding sources are already ≤1080p, so the only gain is GOP
            // density for scrubbing, and this piece is watched, not scrubbed.
            skipProxyGeneration: true,
          });
          // Key on the SLUG, never on `stored.filename`: `storeFile` dedupes
          // within a piece, so a re-run can land as "logo-mark (1).png".
          fileIdBySlug.set(asset.slug, stored.fileId);
          bytes += stored.bytes;
        } catch (err) {
          throw new Error(
            `onboarding: asset ${asset.slug} failed: ${err instanceof Error ? err.message : String(err)}`,
            { cause: err },
          );
        }
        ctx.reportProgress(index + 1, assets.length, "files");
      }

      if (ctx.shouldCancel()) throw new CancelledError(ctx.jobId);

      const overlays = resolveSlugs(definition.overlays, fileIdBySlug) as unknown as PersistedOverlay[];
      const audioClips = resolveSlugs(definition.audioClips, fileIdBySlug) as unknown as PersistedAudioClip[];

      const manifest: CompositionManifest = {
        width: definition.width,
        height: definition.height,
        fps: definition.fps,
        overlays,
        audioClips,
      };
      // `saveManifest` is what writes the code-bearing overlays' bodies out to
      // their per-overlay files (it calls `writeOverlayCode` for every overlay
      // and then serialises a stripped clone) — so there is deliberately no
      // second `writeOverlayCode` loop here. Adding one would write the same
      // four files twice and imply the save could not be trusted to do it.
      await saveManifest(pieceId, manifest);

      // THE LAST WRITE, and it must stay last. Until this lands the piece is
      // provisional and invisible to dedupe; after it, the piece is the demo.
      getDb()
        .update(pieces)
        .set({ description: onboardingMarker(version), updatedAt: new Date() })
        .where(eq(pieces.id, pieceId))
        .run();

      logger.info(
        {
          tag: "onboarding",
          op: "built",
          version,
          pieceId,
          assets: fileIdBySlug.size,
          bytes,
          overlays: overlays.length,
        },
        "onboarding: demo piece built",
      );

      result = { pieceId, version, bytes, assets: fileIdBySlug.size, reused: false };
    } catch (err) {
      // Everything, or nothing. The rollback is wrapped in its own try so a
      // failure to delete can never mask the error that caused it.
      try {
        await deletePieceCompletely(pieceId);
      } catch (rollbackErr) {
        logger.error(
          {
            tag: "onboarding",
            op: "rollback_failed",
            version,
            pieceId,
            err: rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr),
          },
          "onboarding: could not clean up the partial demo piece",
        );
      }
      throw err;
    }

    // OUTSIDE the rollback scope on purpose. `trackServerEvent` is a
    // synchronous enqueue that cannot throw, so this is decoupling rather
    // than a bug fix — but a piece that is fully built and marked must never
    // become deletable because an analytics call went wrong. Bounded-
    // cardinality param only: the definition version. A pieceId here would
    // be unbounded user data.
    trackServerEvent("onboarding_piece_built", { version });

    return result;
  },
};
