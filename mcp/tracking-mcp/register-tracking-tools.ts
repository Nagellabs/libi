import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as tools from "@/mcp/tools";
import {
  ComputeObjectTrackShape,
  ComputeObjectTrackProvidersShape,
  AddTrackedOverlaySchema,
  UpdateTrackedOverlaySchema,
  DeleteTrackSchema,
  ListTracksSchema,
  UpdateTrackResultSchema,
  ComputeTrackSegmentSchema,
  SkipSegmentSchema,
  ListTrackSegmentsSchema,
  GroundTargetSchema,
  RefineTrackWithSam2Schema,
  VerifyInstallSchema,
  VerifyTrackedOverlayShape,
  ListIdentityCandidatesSchema,
  PickCandidateSchema,
  RemoveBackgroundSchema,
} from "@/mcp/tools/schemas";
import { notify } from "@/mcp/notify";

// Accepts both the loose `ToolResult` and the canonical generic
// `ToolResultOf<…>` (tracking tools return the latter) — the sink only
// serializes, so the structural supertype is the right param type.
function makeContent(result: tools.AnyToolResult) {
  return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
}

function makeError(err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  return {
    content: [{ type: "text" as const, text: JSON.stringify({ success: false, error: message }) }],
    isError: true,
  };
}

type McpBlock =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

export function buildVerifyContent(result: tools.AnyToolResult): {
  content: McpBlock[];
  isError?: boolean;
} {
  if (!result.success) {
    return {
      content: [{ type: "text", text: JSON.stringify({ success: false, error: result.error }) }],
      isError: true,
    };
  }
  const data = (result.data ?? {}) as {
    frames?: { pngBase64?: string }[];
  } & Record<string, unknown>;
  const frames = data.frames ?? [];
  const blocks: McpBlock[] = [];
  for (const f of frames) {
    if (f.pngBase64) blocks.push({ type: "image", data: f.pngBase64, mimeType: "image/png" });
  }
  const lean = {
    ...data,
    frames: frames.map((f) => {
      const { pngBase64, ...rest } = f;
      return { ...rest, hasImage: !!pngBase64 };
    }),
  };
  blocks.push({ type: "text", text: JSON.stringify({ success: true, data: lean }) });
  return { content: blocks };
}

/**
 * Register the tracking + background-removal tools on a given MCP server.
 *
 * This is the SINGLE source of truth for the tracking tool surface. It is
 * called from BOTH:
 *  - `mcp/server.ts#createLibiMcpServer()` — the always-on core `libi` MCP.
 *    Hosting the tools here guarantees they are present in EVERY agent
 *    session (claude-agent-acp loads MCP servers at session-creation time;
 *    a separately-spawned tier-2 MCP could race that and leave the agent
 *    with no tracking tools — the exact dogfood failure this fixes).
 *  - `mcp/tracking-mcp/server.ts#createTrackingMcpServer()` — the standalone
 *    `libi serve-mcp-tracking` CLI entry, kept for packaging parity.
 *
 * The tool implementation functions + schemas are unchanged — they still
 * call the Next.js server over HTTP via runJobViaServer, so which MCP hosts
 * them is behavior-neutral. The heavy Python tracking engine stays lazy
 * (tier-2): tools return a structured `tracking_engine_not_installed` error
 * until it is provisioned. Only the *tool surface* is always-on; the
 * ~1 GB / 10-min engine install is still deferred off the boot path.
 */
export function registerTrackingTools(server: McpServer): void {
  server.registerTool(
    "libi.compute_object_track",
    {
      description:
        "STOP — before using this you MUST invoke the `using-object-tracking` skill via the Skill " +
        "tool and follow it (anchor density, the in-between verification grid, the repair loop). " +
        "Reading the SKILL.md via Read/grep/ToolSearch is NOT a substitute for invoking the Skill tool. " +
        "DEFAULT tracker — local, free. Track a subject across the whole clip. Auto-detects shots " +
        "and computes one segment per shot (recompute a bad window later with libi.compute_track_segment). " +
        "Returns {trackId, segments[], summary{perSegment,visibleRanges,lostRanges,flags}}. " +
        "Returns a trackId compatible with libi.add_tracked_overlay. " +
        "For pixel-precise mask refinement after tracking, see libi.refine_track_with_sam2 (PAID, opt-in). " +
        "Dedup is handled per-segment inside the shot fan-out — sub-job markers " +
        "(attachedToRunning/matchedExisting) are not surfaced at the fan-out result. " +
        "Pass forceNew:true to force every per-shot segment recompute (e.g., after the " +
        "source video changed); default false reuses recently-computed matching segments.",
      inputSchema: ComputeObjectTrackShape,
    },
    async (params, extra) => {
      try {
        const result = await tools.computeObjectTrack(params, extra);
        return makeContent(result);
      } catch (err) { return makeError(err); }
    },
  );

  server.registerTool(
    "libi.compute_object_track_providers",
    {
      description:
        "OPTIONAL PAID mask refinement via fal.ai SAM2. NOT the default tracker — use " +
        "libi.compute_object_track / libi.compute_track_segment (local, free) first. " +
        "Use SAM2 only when a precise mask is needed for object replacement / matting. " +
        "Requires FAL_KEY configured in Settings → MCP Servers → fal-ai. " +
        "Returns a trackId compatible with libi.add_tracked_overlay. " +
        "Dedup signals — when the tool returns `attachedToRunning:true`, the server " +
        "attached this call to a still-running matching job and BLOCKED until it " +
        "finished, so a fresh track IS available in this response; inform the user " +
        "we continued an existing run (mention elapsed time from `existingJob.startedAt`) " +
        "and ASK if they prefer a separate fresh run (retry with `forceNew:true`). " +
        "When the tool returns `matchedExisting:true`, the track is already computed " +
        "and saved — proceed to use the trackId. Use `forceNew:true` only to recompute " +
        "the track (e.g., after the source video changed).",
      inputSchema: ComputeObjectTrackProvidersShape,
    },
    async (params, extra) => {
      try {
        const result = await tools.computeObjectTrackProviders(params, extra);
        return makeContent(result);
      } catch (err) { return makeError(err); }
    },
  );

  server.registerTool(
    "libi.refine_track_with_sam2",
    {
      description:
        "Refine an existing box track into precise SAM2 masks over an optional time range " +
        "(PAID, fal.ai, requires user approval). Adds a 'sam2-refine' segment. " +
        "Not a tracker — refines a track you already have from libi.compute_object_track. " +
        "Only use when a precise pixel mask is needed (e.g. object replacement / matting).",
      inputSchema: RefineTrackWithSam2Schema,
    },
    async (params, extra) => {
      try {
        const result = await tools.refineTrackWithSam2(params, extra);
        return makeContent(result);
      } catch (err) { return makeError(err); }
    },
  );

  server.registerTool(
    "libi.add_tracked_overlay",
    {
      description:
        "Pin an overlay (emoji, text, image, video, code, or blur/pixelate effect) to a moving subject. Requires a trackId from libi.compute_object_track. `fit` controls how the bbox maps to overlay size: 'tight'=face bbox, 'head'=bbox extended upward for full head, 'rect'=use overlay.rect size centered on bbox. `scale` is a multiplier on top of fit — set per case to cover the subject as desired (1.0 = bbox-tight; 1.2-1.4 typical for emoji on faces; agent decides).",
      inputSchema: AddTrackedOverlaySchema,
    },
    async (params) => {
      try {
        const result = await tools.addTrackedOverlay(params);
        if (result.success) notify.refreshQuery({ queryKey: "composition", pieceId: params.pieceId });
        return makeContent(result);
      } catch (err) { return makeError(err); }
    },
  );

  server.registerTool(
    "libi.update_tracked_overlay",
    {
      description:
        "Update any field of a tracked overlay (track binding, content, timing, rect, z, opacity, fit, scale, smoothing). Only provided fields are changed. Set offset ({x,y} in fractions of the tracked box, e.g. {x:0,y:-1} = one box-height above the head) to reposition the content while it keeps following the track — this never modifies the track itself. Position bounce: positionMode 'stabilized' (the default) already applies render-time One-Euro position smoothing; 'raw' opts out for a deliberately bouncy look. Do NOT change `smoothing` to fix jitter — it is sub-frame interpolation, not a denoiser.",
      inputSchema: UpdateTrackedOverlaySchema,
    },
    async (params) => {
      try {
        const result = await tools.updateTrackedOverlay(params);
        if (result.success) notify.refreshQuery({ queryKey: "composition", pieceId: params.pieceId });
        return makeContent(result);
      } catch (err) { return makeError(err); }
    },
  );

  server.registerTool(
    "libi.delete_track",
    {
      description:
        "Delete a track (DB row + JSON sidecar). Tracked overlays that reference this trackId will fail to render until they're updated or removed.",
      inputSchema: DeleteTrackSchema,
    },
    async (params) => {
      try {
        const result = await tools.deleteTrack(params);
        if (result.success && result.data?.pieceId) {
          notify.refreshQuery({ queryKey: "composition", pieceId: result.data.pieceId });
        }
        return makeContent(result);
      } catch (err) { return makeError(err); }
    },
  );

  server.registerTool(
    "libi.list_tracks",
    {
      description: "List all tracks computed for a source file.",
      inputSchema: ListTracksSchema,
    },
    async (params) => {
      try {
        const result = await tools.listTracks(params);
        return makeContent(result);
      } catch (err) { return makeError(err); }
    },
  );

  server.registerTool(
    "libi.update_track_result",
    {
      description:
        "Write externally-computed tracking samples into libi's track store. " +
        "Use when you ran tracking outside libi (e.g., via a different MCP or external tool) and want to write the result into libi's track store. " +
        "Returns a trackId you can pass to libi.add_tracked_overlay. " +
        "Replace-only semantics: passing the same trackId twice discards prior samples.",
      inputSchema: UpdateTrackResultSchema,
    },
    async (params) => {
      try {
        const result = await tools.updateTrackResult(params);
        return makeContent(result);
      } catch (err) { return makeError(err); }
    },
  );

  server.registerTool(
    "libi.compute_track_segment",
    {
      description:
        "STOP — invoke the `using-object-tracking` skill (Skill tool) and follow it before using this; " +
        "this tool is the repair step of that skill's loop. " +
        "Compute or replace ONE time-range segment of a track with a chosen method (yoloe+botsort | yoloe-text | sot). Recomputes only this window; other segments untouched. Returns per-segment quality `summary` (visibleRanges, lostRanges, flags).",
      inputSchema: ComputeTrackSegmentSchema,
    },
    async (params, extra) => {
      try {
        const result = await tools.computeTrackSegment(params, extra);
        return makeContent(result);
      } catch (err) { return makeError(err); }
    },
  );

  server.registerTool(
    "libi.skip_segment",
    {
      description:
        "Mark a time range as intentionally untracked (e.g. subject not visible / back to camera). Renders nothing there. Honest — prefer this over a bad track.",
      inputSchema: SkipSegmentSchema,
    },
    async (params) => {
      try {
        const result = await tools.skipSegment(params);
        return makeContent(result);
      } catch (err) { return makeError(err); }
    },
  );

  server.registerTool(
    "libi.list_track_segments",
    {
      description:
        "List a track's segments with per-segment status/quality (ok|lost|skipped, visible/total counts, reason).",
      inputSchema: ListTrackSegmentsSchema,
    },
    async (params) => {
      try {
        const result = await tools.listTrackSegments(params);
        return makeContent(result);
      } catch (err) { return makeError(err); }
    },
  );

  server.registerTool(
    "libi.ground_target",
    {
      description:
        "STOP — invoke the `using-object-tracking` skill (Skill tool) and follow it before any tracking work. " +
        "Stage-0 grounding (set-of-marks): detect candidate objects at a timestamp and return NUMBERED boxes. " +
        "LOOK at the frame, pick the index matching the user's target, then pass that bbox as the anchor to " +
        "libi.compute_track_segment / libi.compute_object_track. Do NOT hand-guess pixel coordinates.",
      inputSchema: GroundTargetSchema,
    },
    async (params, extra) => {
      try {
        const result = await tools.groundTarget(params, extra);
        return makeContent(result);
      } catch (err) { return makeError(err); }
    },
  );

  server.registerTool(
    "libi.verify_install",
    {
      description:
        "Check whether the libi-tracking engine (uv Python env + ONNX models) is installed and its self-test passes. " +
        "Returns {ok, installed, missing[], versions}. Takes no parameters. " +
        "Call this if a tracking tool returned tracking_engine_not_installed (if not installed, " +
        "libi.install_tracking_engine runs the actual install), and again after installing to confirm. " +
        "On success this ALSO closes the lazy-install loop — it persists the tracking engine as installed in the dependency registry the tracking gate reads, so the next tracking call is unblocked with no manual DB patch and no update_dep_status needed.",
      inputSchema: VerifyInstallSchema,
    },
    async (params) => {
      try {
        const result = await tools.verifyInstall(params);
        return makeContent(result);
      } catch (err) { return makeError(err); }
    },
  );

  server.registerTool(
    "libi.verify_tracked_overlay",
    {
      description:
        "STOP — invoke the `using-object-tracking` skill (Skill tool) and follow it. " +
        "Read-only visual verify: renders the tracked overlay on the source footage at the " +
        "frames most likely to be wrong (every issue/lost/flagged range + the final seconds, " +
        "anchor frames excluded) and returns those frames as images plus per-frame tracking " +
        "context + the track summary. LOOK at the returned frames; if a window is wrong, fix it " +
        "with libi.compute_track_segment / libi.skip_segment, then verify again. Pre-attach: " +
        "pass {fileId,trackId,content,fit} (+ optional offset to spot-check a follow-offset " +
        "placement, sizeMode/maxBoxScale to spot-check a non-default box-size policy, " +
        "and/or positionMode to spot-check the position-stabilization policy, " +
        "before attaching — post-attach the overlay's own values win). Post-attach: pass " +
        "{pieceId,overlayId}. It never re-tracks and never writes the track.",
      inputSchema: VerifyTrackedOverlayShape,
    },
    async (params) => {
      try {
        const result = await tools.verifyTrackedOverlay(params);
        return buildVerifyContent(result);
      } catch (err) {
        return makeError(err);
      }
    },
  );

  server.registerTool(
    "libi.list_identity_candidates",
    {
      description:
        "STOP — invoke the `using-object-tracking` skill (Skill tool) and follow it. " +
        "Identity disambiguation: when a window is ambiguous (≥2 similar subjects the " +
        "appearance gate cannot separate — e.g. a cameraman in matching clothing), " +
        "re-runs detect→track over the window and returns the competing candidate tracklets " +
        "as differently-colored frames for visual inspection. " +
        "Returns {ambiguous, candidates:[{candidateId,meanTargetSim,frameCount}], frames:[…]}. " +
        "LOOK at the returned frames, identify the correct subject by candidateId, then call " +
        "libi.pick_candidate to lock that candidate as an authoritative agent segment. " +
        "Not a paid tool — runs the local engine (same as libi.compute_track_segment).",
      inputSchema: ListIdentityCandidatesSchema,
    },
    async (params, extra) => {
      try {
        const result = await tools.listIdentityCandidates(params, extra);
        return buildVerifyContent(result);
      } catch (err) {
        return makeError(err);
      }
    },
  );

  server.registerTool(
    "libi.pick_candidate",
    {
      description:
        "STOP — invoke the `using-object-tracking` skill (Skill tool) and follow it. " +
        "Pick one candidate from libi.list_identity_candidates by candidateId. " +
        "Writes the chosen tracklet's boxes as a provenance:'agent' segment that authorita­tively " +
        "owns its window regardless of appearance/positional thresholds (stronger than the engine, " +
        "weaker than a user manual drag). Stores the pick in agentAnchors so later recomputes " +
        "re-seed from the correct subject. " +
        "Returns {trackId, segmentId, summary} — verify with libi.verify_tracked_overlay after. " +
        "Not a paid tool — runs the local engine (same as libi.compute_track_segment).",
      inputSchema: PickCandidateSchema,
    },
    async (params, extra) => {
      try {
        const result = await tools.pickCandidate(params, extra);
        return makeContent(result);
      } catch (err) {
        return makeError(err);
      }
    },
  );

  server.registerTool(
    "libi.remove_background",
    {
      description:
        "STOP — before using this you MUST invoke the `removing-and-replacing-backgrounds` skill via the Skill " +
        "tool and follow it (subject pick, local-vs-fal routing, the verify-pixels step, compose/transplant). " +
        "Produce an alpha CUTOUT asset (subject isolated, background transparent) from a VIDEO file. " +
        "LOCAL + FREE by default (MatAnyone, seeded from libi's subject masks) — a long job with live progress. " +
        "Returns {cutoutFileId} — a VP9-alpha WebM you place with libi.add_overlay over any new background " +
        "(add the background as a full-frame overlay too, at a LOWER z); export honors the alpha as-is. " +
        "subject: omit for auto (largest person) or pass a libi.ground_target candidate bbox. " +
        "Photos + non-person/low-quality cases route to the PAID fal path (bria video / birefnet image) — " +
        "the skill owns that flow; engine:'fal' here only returns those instructions.",
      inputSchema: RemoveBackgroundSchema,
    },
    async (params, extra) => {
      try {
        const result = await tools.removeBackground(params, extra);
        return makeContent(result);
      } catch (err) { return makeError(err); }
    },
  );
}
