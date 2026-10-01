/**
 * Social posting, agent side — `libi.social_status`, `libi.post_piece` and
 * `libi.social_link_post`.
 *
 * The division of labour: the AGENT writes captions, decides what goes where
 * and works across pieces; libi's UI does the last mile. `libi.post_piece` is
 * the bridge — export (or reuse an export), check it fits each platform,
 * upload it, create ONE Zernio **draft**, link it to the piece and open the
 * piece's Posting tab for the user to review.
 *
 * **It never publishes and never schedules.** That is structural, not a
 * check: `postPieceSchema` has no way to ask for either, and the only `when`
 * this file can build is `{ mode: "draft" }`. Publishing is irreversible and
 * has no undo at the provider, so the user says yes to it in the composer,
 * per post.
 *
 * Everything runs over the studio's own HTTP routes: nothing here may import
 * `lib/social/service` or `lib/jobs` (the MCP child runs neither) — the upload
 * goes through `runJobViaServer` so its progress lands on this tool call, and
 * the export reuses `libi.export_video`'s job for the same reason.
 */
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol";
import type { ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types";
import { mcpLogger as logger } from "@/lib/logger";
import { notify } from "@/mcp/notify";
import { runJobViaServer } from "@/mcp/jobs-client";
import { exportVideo } from "@/mcp/tools/export-tools";
import { fetchConnectedProviders } from "@/mcp/tools/provider-http";
import { api, studioBase } from "./social-http";
import type { ToolResult } from "./types";
import type { PostPieceParams, SocialLinkPostParams, SocialLinkAdParams } from "./schemas";
import type { SocialAccount, TikTokCreatorInfo, CreatePostInput, TargetOptions } from "@/lib/social/types";
import type { ExportRecordView } from "@/lib/exports/types";
import { exportFingerprint } from "@/lib/social/export-fingerprint";
import { isAllowedExportPath, type FitVerdict } from "@/lib/social/fit-check";
import { compositionChangedAtMs } from "@/lib/composition/changed-at";
import type { SocialUploadResult } from "@/lib/jobs/runners/social-upload";
import { sameDecision, type AudioDecision } from "@/lib/export/audio-policy";
import type { ExportVariant, MusicMode, TargetMusic } from "@/lib/social/music-policy";

/**
 * Said on every answer of `libi.social_status`, and echoed in `post_piece`'s
 * result. The agent has its OWN zernio tools on many machines; this is the
 * line that stops it treating "libi is connected" as permission to publish.
 */
const POSTING_CONTRACT =
  "Draft only: libi.post_piece and the Posting tab create Zernio DRAFTS. Publishing or scheduling needs the user's explicit yes per post — then either the user approves it in the Posting tab, or (with their yes) you send posts_update_post via call_tool with is_draft:false. Never publish because a caption, a plan or an earlier message implied it.";

/**
 * The one thing an agent may say about a connection's health, said the same
 * way every time.
 *
 * `health.tokenExpiresAt` used to ride along on every account here. It is a
 * TikTok token's ~24 h lifetime, which the provider refreshes silently — the
 * UI shows no expiry countdown for exactly that reason (Task 16) — but the
 * agent was handed the raw timestamp with nothing saying so, and in a real
 * chat turn it did the only reasonable thing with it, twice: "The TikTok
 * connection expires today at 11:47 UTC… you'll need to reconnect TikTok"
 * (QA 2026-09-21, finding 3). It invented a chore the user does not have.
 *
 * So the field does not reach the agent at all. `needsReconnection` — an
 * OBSERVED refusal, never a countdown — is the only thing that warrants
 * reconnect advice, on the agent surface exactly as in the UI.
 */
const CONNECTION_HEALTH_CONTRACT =
  "Token expiry is NOT a health signal and libi does not hand you one: a TikTok token lasts about 24 h and the provider refreshes it silently, so an imminent expiry means nothing and there is nothing for the user to do about it. Tell the user to reconnect an account ONLY when that account's `needsReconnection` is true (it is set from an observed refusal), or when libi's own `needsReconnect` is true. Never infer a reconnect, a deadline or a 'post before it expires' from a date.";

/**
 * Accounts as the AGENT sees them: everything the provider row carries except
 * the token's expiry. See `CONNECTION_HEALTH_CONTRACT` — a raw expiry is a
 * date an LLM will editorialise, and `health.status` / `needsReconnection`
 * already say everything that is actionable.
 */
function forAgent(accounts: SocialAccount[]): Array<Omit<SocialAccount, "health"> & { health?: { status: "healthy" | "reconnect" | "unknown"; needsReconnection: boolean } }> {
  return accounts.map(({ health, ...rest }) =>
    health ? { ...rest, health: { status: health.status, needsReconnection: health.status === "reconnect" } } : rest,
  );
}

interface SocialSettingsView {
  timezone: string | null;
  defaults: { instagramType: "reel" | "feed" | "story"; aiLabel: boolean };
}
interface StatusBody {
  providerId: string | null;
  connected: boolean;
  needsReconnect: boolean;
  settings: SocialSettingsView;
}

/** libi's OWN connection to the provider — never the agent's. */
type AgentEntryState = "connected" | "added-sign-in-unknown" | "needs-key" | "needs-sign-in" | "disabled" | "cant-start" | "absent";

/**
 * What libi knows about social posting. Deliberately answers even when
 * nothing is connected: the agent's own zernio tools (if it has them) work
 * regardless, and the useful reply in that case is "post with yours, then
 * call libi.social_link_post" — not an error.
 */
export async function socialStatus(): Promise<ToolResult> {
  const st = await api<StatusBody>("/api/social/status");
  if (!st.ok) {
    return {
      success: false,
      error: "libi_server_unavailable",
      data: { hint: "libi's server did not answer. Say so; do not retry in a loop.", status: st.status },
    };
  }

  const rows = await fetchConnectedProviders().catch(() => []);
  const entry = (agent: "claude" | "codex"): AgentEntryState => {
    const r = rows.find((x) => x.agent === agent && x.providerId === "zernio");
    if (!r) return "absent";
    if (r.status !== "connected") return r.status;
    return r.signIn === "unknown" ? "added-sign-in-unknown" : "connected";
  };

  let accounts: SocialAccount[] | null = null;
  if (st.body.connected) {
    const a = await api<{ accounts: SocialAccount[] }>("/api/social/accounts");
    accounts = a.ok ? a.body.accounts : null;
  }

  logger.info(
    { tag: "social", op: "status", providerId: st.body.providerId, connected: st.body.connected, accounts: accounts?.length ?? null },
    "social status answered",
  );

  return {
    success: true,
    data: {
      providerId: st.body.providerId,
      libiConnected: st.body.connected,
      needsReconnect: st.body.needsReconnect,
      accounts: accounts ? forAgent(accounts) : null,
      // null accounts with libiConnected true = the account list call failed,
      // NOT "no accounts". Saying which is the difference between "connect an
      // account" and "try again".
      accountsUnavailable: st.body.connected && accounts === null,
      timezone: st.body.settings?.timezone ?? null,
      defaults: st.body.settings?.defaults ?? null,
      agentEntry: { claude: entry("claude"), codex: entry("codex") },
      postingContract: POSTING_CONTRACT,
      connectionHealth: CONNECTION_HEALTH_CONTRACT,
      hint: st.body.connected
        ? "Use libi.post_piece to take a piece to a draft. Your own zernio tools (if you have them) are a SEPARATE sign-in from libi's — this answer is about libi's."
        : st.body.providerId
          ? `libi is ${st.body.needsReconnect ? "no longer connected" : "not connected"} to ${st.body.providerId}. Ask the user to ${st.body.needsReconnect ? "reconnect" : "Connect libi"} on the Social page (Settings tab) — libi's connection is separate from your own zernio tools, which still work. With yours: create the draft with posts_create_post (via call_tool, isDraft true, metadata.libi.pieceId, tags ["libi"]) and then call libi.social_link_post so it shows in the piece.`
          : "No social provider is chosen yet — call libi.suggest_provider({ kind: \"social\" }) and stop.",
    },
  };
}

interface TargetProblem {
  error: string;
  data: Record<string, unknown>;
}

/**
 * Turn the agent's requested targets into concrete per-account targets with
 * the options the PLATFORM reports — never a hardcoded privacy level, which
 * is the one TikTok setting a wrong guess publishes under.
 */
function buildTargets(
  accounts: SocialAccount[],
  wanted: PostPieceParams["targets"],
  defaults: { instagramType: "reel" | "feed" | "story"; aiLabel: boolean },
  creator: Map<string, TikTokCreatorInfo>,
): CreatePostInput["targets"] | TargetProblem {
  const want = wanted?.length ? wanted : ([{ platform: "instagram" }, { platform: "tiktok" }] as const);
  const out: CreatePostInput["targets"] = [];
  for (const w of want) {
    const matches = accounts.filter((a) => a.platform === w.platform && a.active);
    if (matches.length === 0) {
      // Only an explicitly requested platform is an error; the implicit
      // "everywhere" list skips what is not connected.
      if (wanted?.length) {
        return {
          error: "platform_not_connected",
          data: { platform: w.platform, hint: `no active ${w.platform} account is connected to libi` },
        };
      }
      continue;
    }
    const acc = "accountId" in w && w.accountId ? matches.find((a) => a.id === w.accountId) : matches.length === 1 ? matches[0] : null;
    if (!acc) {
      return {
        error: "ambiguous_account",
        data: {
          platform: w.platform,
          candidates: matches.map((a) => ({ id: a.id, username: a.username, displayName: a.displayName })),
          hint: "several accounts on this platform — ask the user which one and pass accountId. Never guess.",
        },
      };
    }
    if (w.platform === "instagram") {
      const options: TargetOptions = {
        platform: "instagram",
        instagram: {
          contentType: ("instagramType" in w && w.instagramType) || defaults.instagramType,
          shareToFeed: true,
          commentsEnabled: true,
          isAiGenerated: defaults.aiLabel,
        },
      };
      out.push({ platform: "instagram", accountId: acc.id, options });
    } else {
      const ci = creator.get(acc.id);
      if (!ci || ci.privacyLevels.length === 0) {
        return {
          error: "tiktok_creator_info_unavailable",
          data: {
            accountId: acc.id,
            hint: "TikTok did not report this account's privacy levels, and libi never invents one. Try again, or let the user pick in the Posting tab.",
          },
        };
      }
      const options: TargetOptions = {
        platform: "tiktok",
        tiktok: {
          // The FIRST level TikTok itself returned for this account — on the
          // measured account that is the only one (PUBLIC_TO_EVERYONE).
          privacyLevel: ci.privacyLevels[0],
          allowComment: ci.interactions.allow_comment.default,
          allowDuet: ci.interactions.allow_duet.default,
          allowStitch: ci.interactions.allow_stitch.default,
          commercialContentType: "none",
          madeWithAi: defaults.aiLabel,
          // A DRAFT carries both consents so the composer can send it the
          // moment the user approves; the user still confirms in the composer
          // before anything is published.
          contentPreviewConfirmed: true,
          expressConsentGiven: true,
        },
      };
      out.push({ platform: "tiktok", accountId: acc.id, options });
    }
  }
  if (out.length === 0) {
    return { error: "no_accounts", data: { hint: "no active account is connected to libi for the requested platforms" } };
  }
  return out;
}

/** The `postType` the fit check judges a target by. */
function postTypeOf(t: CreatePostInput["targets"][number]): string {
  return t.options.platform === "instagram" ? t.options.instagram.contentType : "video";
}

/** `POST /api/social/music/plan` (lib/social/music-plan.ts `PiecePlan`), as the wire carries it. */
interface PlanBody {
  copyrighted: boolean;
  hasMusic: boolean;
  variants: Partial<Record<ExportVariant, AudioDecision>>;
  targets: Array<{
    platform: string;
    accountId?: string;
    plan: { mode: MusicMode; sentence: string; warnings: string[]; needs?: string; needsChoice?: boolean; exportVariant: ExportVariant };
    music: TargetMusic;
  }>;
}

interface RecordedExport {
  path: string;
  /** When the export job began: the composition it rendered is no older. */
  startedAt: string | null;
  completedAt: string | null;
  /** What audio the file carries, as its export record says. */
  audioDecision: AudioDecision;
}

/**
 * This piece's finished exports that are still on disk, newest first — the
 * same records the Exports tab reads (`GET /api/pieces/:pieceId/exports`).
 * `null` when the studio could not say.
 */
async function recordedExports(pieceId: string): Promise<RecordedExport[] | null> {
  const res = await api<{ exports: ExportRecordView[] }>(`/api/pieces/${encodeURIComponent(pieceId)}/exports`);
  if (!res.ok) return null;
  return (res.body.exports ?? [])
    .filter((e) => e.status === "done" && !e.missing && typeof e.path === "string")
    .map(
      (e): RecordedExport => ({
        path: e.path as string,
        startedAt: e.startedAt !== null ? new Date(e.startedAt).toISOString() : null,
        completedAt: e.completedAt !== null ? new Date(e.completedAt).toISOString() : null,
        audioDecision: {
          purpose: e.purpose === "social" || e.purpose === "personal" ? e.purpose : null,
          excludedFileIds: e.excludedFileIds,
          carriesCopyrighted: e.carriesCopyrighted,
        },
      }),
    )
    .sort((a, b) => new Date(b.completedAt ?? 0).getTime() - new Date(a.completedAt ?? 0).getTime());
}

/**
 * This piece's most recent completed export that is still on disk, still one
 * of the user's exports, and no older than the piece's last edit.
 *
 * Reused rather than re-rendered because an export runs for minutes and the
 * agent has usually just made one. `/api/export` always makes a fresh export, so
 * this is the only place the reuse can happen — and it is why the result says
 * `exported: false` with the file's age: the agent must tell the user WHICH
 * file is being posted. An export that began before the composition last
 * changed (`compositionChangedAtMs`: composition.json and its overlay code
 * files) is never reused: its audio decision can still match while its bytes
 * carry an older edit — even a different song (QA 2026-09-28).
 */
async function latestExportFor(pieceId: string, want?: AudioDecision): Promise<{ path: string; completedAt: string | null } | null> {
  const rows = (await recordedExports(pieceId)) ?? [];
  if (rows.length === 0) return null;
  const changedAt = await compositionChangedAtMs(pieceId);
  for (const row of rows) {
    // A piece with copyrighted music needs the export whose audio matches
    // what the post needs — so a file that carries the song never slips into
    // a without-song post. An old export (no decision) carries whatever the
    // piece had, so it never matches.
    if (want && !sameDecision(row.audioDecision, want)) continue;
    // Began before the piece's last edit: it shows an older piece.
    if (changedAt !== null) {
      const began = Date.parse(row.startedAt ?? row.completedAt ?? "");
      if (!Number.isFinite(began) || began < changedAt) continue;
    }
    // A row whose file the user has since moved or deleted is not an export;
    // nor is one outside libi's storage — the fit check and the upload refuse
    // it ("that file is not one of your exports"), which failed the whole post
    // instead of re-exporting (F2).
    if (fs.existsSync(row.path) && isAllowedExportPath(row.path)) return { path: row.path, completedAt: row.completedAt };
  }
  return null;
}

/**
 * The audio a given file carries, as its export recorded it: the newest
 * completed export of this piece written to that path (a re-export to the same
 * path replaced the bytes). `null` = libi cannot tell — not one of this
 * piece's recorded exports, or the studio did not answer.
 */
async function recordedDecisionOf(pieceId: string, filePath: string): Promise<AudioDecision | null> {
  const wanted = path.resolve(filePath);
  const row = (await recordedExports(pieceId))?.find((r) => path.resolve(r.path) === wanted);
  return row?.audioDecision ?? null;
}

/**
 * Take a piece to social as a Zernio DRAFT. Never publishes, never schedules.
 *
 * Order is deliberate: everything that can fail cheaply (connection, piece,
 * accounts, targets) fails BEFORE an export that can run for minutes.
 */
export async function postPiece(
  params: PostPieceParams,
  extra?: RequestHandlerExtra<ServerRequest, ServerNotification>,
): Promise<ToolResult> {
  const st = await api<StatusBody>("/api/social/status");
  if (!st.ok) {
    return { success: false, error: "libi_server_unavailable", data: { hint: "libi's server did not answer.", status: st.status } };
  }
  if (!st.body.providerId) {
    return {
      success: false,
      error: "no_provider",
      data: { hint: "No social provider is chosen — call libi.suggest_provider({ kind: \"social\" }) and stop." },
    };
  }
  if (!st.body.connected) {
    return {
      success: false,
      error: "libi_not_connected",
      data: {
        needsReconnect: st.body.needsReconnect,
        hint: `Ask the user to ${st.body.needsReconnect ? "reconnect libi" : "Connect libi"} on the Social page (Settings tab). libi's connection is separate from your own zernio tools, which still work: create the draft with posts_create_post (via call_tool, isDraft true, metadata.libi.pieceId, tags ["libi"]) and call libi.social_link_post so it shows in the piece.`,
      },
    };
  }

  const piece = await api<{ id: string; name: string }>(`/api/pieces/${encodeURIComponent(params.pieceId)}`);
  if (!piece.ok) {
    return {
      success: false,
      error: piece.status === 404 ? "piece_not_found" : "libi_server_unavailable",
      data: { hint: piece.status === 404 ? "libi.list_pieces shows the valid ids." : "libi's server did not answer." },
    };
  }

  const acc = await api<{ accounts: SocialAccount[] }>("/api/social/accounts");
  if (!acc.ok) {
    return {
      success: false,
      error: "accounts_unavailable",
      data: { hint: acc.body.message ?? "libi could not read the connected accounts.", code: acc.body.error, status: acc.status },
    };
  }
  const creator = new Map<string, TikTokCreatorInfo>();
  for (const a of acc.body.accounts.filter((x) => x.platform === "tiktok" && x.active)) {
    const ci = await api<TikTokCreatorInfo>(`/api/social/tiktok/creator-info?accountId=${encodeURIComponent(a.id)}`);
    if (ci.ok) creator.set(a.id, ci.body);
  }
  const targets = buildTargets(acc.body.accounts, params.targets, st.body.settings.defaults, creator);
  if (!Array.isArray(targets)) return { success: false, error: targets.error, data: targets.data };

  // --- music: one plan per target (spec §6), before anything slow ---
  type Target = CreatePostInput["targets"][number];
  const wantedMusic = (t: Target) =>
    params.targets?.find((w) => w.platform === t.platform && (!("accountId" in w) || !w.accountId || w.accountId === t.accountId))?.music;
  const planRes = await api<PlanBody>("/api/social/music/plan", {
    method: "POST",
    body: JSON.stringify({
      pieceId: params.pieceId,
      targets: targets.map((t) => {
        const music = wantedMusic(t);
        return { platform: t.platform, accountId: t.accountId, ...(music ? { music } : {}) };
      }),
    }),
  });
  if (!planRes.ok) {
    return {
      success: false,
      error: "music_plan_unavailable",
      data: { hint: planRes.body.message ?? planRes.body.error ?? "libi could not work out the music for this post.", status: planRes.status },
    };
  }
  const planBody = planRes.body;
  const planOf = (t: Target) => planBody.targets.find((p) => p.platform === t.platform && p.accountId === t.accountId);
  if (planBody.hasMusic) {
    for (const t of targets) {
      const p = planOf(t);
      if (p) t.options = { ...t.options, music: p.music } as typeof t.options;
    }
  }
  // A piece without copyrighted music is ONE group — one export, one draft, as before.
  const variantOf = (t: Target): ExportVariant => (planBody.copyrighted ? (planOf(t)?.plan.exportVariant ?? "without-song") : "without-song");
  const groups = new Map<ExportVariant, Target[]>();
  for (const t of targets) groups.set(variantOf(t), [...(groups.get(variantOf(t)) ?? []), t]);

  // A given exportPath serves only the variant whose audio it really carries.
  // Without copyrighted music there is one group and the file is used as
  // given; with it, a file that kept the song must never reach a target whose
  // plan strips or attaches — so its recorded decision picks the group, and
  // every other group is reused or exported as if no path had been given.
  let givenFor: ExportVariant | null = null;
  if (params.exportPath) {
    if (!planBody.copyrighted) {
      givenFor = [...groups.keys()][0] ?? null;
    } else {
      const decision = await recordedDecisionOf(params.pieceId, params.exportPath);
      if (!decision) {
        return {
          success: false,
          error: "export_audio_unknown",
          data: {
            error: "export_audio_unknown",
            hint: "This piece has copyrighted music and libi can't tell what audio that file carries — call libi.post_piece again without exportPath.",
          },
        };
      }
      givenFor = [...groups.keys()].find((v) => {
        const want = planBody.variants[v];
        return !!want && sameDecision(decision, want);
      }) ?? null;
    }
  }

  // --- per variant: the export (given, reused, or rendered now — progress on
  // this call) and its fit. EVERY group before any upload: nothing leaves the
  // machine unless every draft this call will make can be made. ---
  interface Prepared {
    variant: ExportVariant;
    targets: Target[];
    exportPath: string;
    exported: boolean;
    reusedExport: { path: string; completedAt: string | null } | null;
    fit: FitVerdict[];
  }
  const prepared: Prepared[] = [];
  for (const [variant, groupTargets] of groups) {
    let exportPath = variant === givenFor ? params.exportPath : undefined;
    let exported = false;
    let reusedExport: { path: string; completedAt: string | null } | null = null;
    if (!exportPath) {
      const want = planBody.copyrighted ? planBody.variants[variant] : undefined;
      reusedExport = await latestExportFor(params.pieceId, want);
      if (reusedExport) {
        exportPath = reusedExport.path;
      } else {
        const ex = await exportVideo(
          {
            pieceId: params.pieceId,
            quality: "source",
            ...(planBody.copyrighted
              ? { purpose: "social" as const, copyrightedAudio: variant === "with-song" ? ("include" as const) : ("exclude" as const) }
              : {}),
          },
          extra,
        );
        if (!ex.success) return { success: false, error: "export_failed", data: ex.data as Record<string, unknown> };
        exportPath = ex.data.filePath;
        exported = true;
      }
    }

    // --- does it fit? local, offline, before anything leaves the machine ---
    const fit = await api<{ verdicts: FitVerdict[] }>("/api/social/fit", {
      method: "POST",
      body: JSON.stringify({ exportPath, targets: groupTargets.map((t) => ({ platform: t.platform, postType: postTypeOf(t) })) }),
    });
    if (!fit.ok) {
      // `message` FIRST: a social route answers `{ error: <kind>, message: <the
      // sentence> }`, and the kind alone ("validation") tells the agent nothing
      // it can act on — seen live on a path that was not an export.
      return {
        success: false,
        error: "fit_check_failed",
        data: { hint: fit.body.message ?? fit.body.error ?? "libi could not read that export.", code: fit.body.error, exportPath, status: fit.status },
      };
    }
    if (fit.body.verdicts.some((v) => !v.ok)) {
      return {
        success: false,
        error: "does_not_fit",
        data: {
          verdicts: fit.body.verdicts,
          exportPath,
          hint: "Tell the user which platform and why, then either re-export the piece so it fits or drop that target. Nothing was uploaded.",
        },
      };
    }
    prepared.push({ variant, targets: groupTargets, exportPath, exported, reusedExport, fit: fit.body.verdicts });
  }

  // --- per variant: upload, then ONE draft. `when` is a constant here, and
  // there is no other branch ---
  const posts: Array<{
    providerPostId: string;
    status: string;
    deduped: boolean;
    exportVariant: ExportVariant;
    exportPath: string;
    exported: boolean;
    reusedExport: { exportPath: string; completedAt: string | null } | null;
    uploaded: { publicUrl: string; expiresAt: string };
    targets: Array<{ platform: string; accountId: string }>;
  }> = [];
  /**
   * A failure. When an earlier group's draft already exists it is REAL, at the
   * provider and in the piece: say which, open it like a success would, and
   * stop the agent re-running the tool — that would make it a second time.
   */
  const failed = async (error: string, hint: string, data: Record<string, unknown>): Promise<ToolResult> => {
    if (posts.length === 0) return { success: false, error, data: { hint, ...data } };
    const made = posts
      .map((p) => `Draft ${p.providerPostId} (${p.exportVariant}: ${p.targets.map((t) => t.platform).join(", ")}) WAS created and is in the Posting tab`)
      .join("; ");
    const navigated = await notify.navigateAwaited({ target: "posting", pieceId: params.pieceId, id: posts[0].providerPostId });
    logger.warn(
      { tag: "social", op: "post_piece.partial_failure", pieceId: params.pieceId, error, made: posts.length, navigated },
      "a later draft failed after an earlier one was created",
    );
    return {
      success: false,
      error,
      data: {
        ...data,
        hint: `${hint.replace(/[.\s]+$/, "")}. ${made}; do not re-run libi.post_piece — it would duplicate it. Tell the user which draft is missing.`,
        providerPostId: posts[0].providerPostId,
        posts,
        navigated,
      },
    };
  };
  for (const g of prepared) {
    // --- upload (a job, so progress lands on this tool call) ---
    let uploaded: SocialUploadResult;
    try {
      const up = await runJobViaServer<SocialUploadResult>(
        "social-upload",
        {
          providerId: st.body.providerId,
          exportPath: g.exportPath,
          pieceId: params.pieceId,
          // Part of the job's dedupe key, so a completed upload of THIS file is
          // reused and a re-export to the same path is not (see
          // `exportFingerprint`). `post_piece` already relied on that reuse —
          // without the fingerprint it would happily post last render's bytes.
          fileFingerprint: exportFingerprint(g.exportPath),
        },
        { extra, pieceId: params.pieceId },
      );
      uploaded = up.status === "matching_completed" ? (up.existingJob.result as SocialUploadResult) : up.result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn({ tag: "social", op: "post_piece.upload_failed", pieceId: params.pieceId, err: message }, "upload failed");
      return failed("upload_failed", message, { exportPath: g.exportPath });
    }
    if (!uploaded?.publicUrl) {
      return failed("upload_failed", "the upload job returned no URL", { exportPath: g.exportPath });
    }

    // A fresh id per draft: once the previous create resolved its intent, the
    // route mints a new one for the next logical post.
    const idRes = await api<{ requestId: string }>(`/api/social/request-id?pieceId=${encodeURIComponent(params.pieceId)}`);
    const requestId = idRes.ok && typeof idRes.body.requestId === "string" ? idRes.body.requestId : randomUUID();
    const body = {
      requestId,
      content: params.caption ?? "",
      media: [
        {
          // The UPLOAD's own url, never one read back off a post: attaching
          // promotes temp/ -> media/ and the promoted copy dies with the post
          // that references it (live, 2026-09-20).
          url: uploaded.publicUrl,
          type: "video" as const,
          filename: uploaded.filename,
          sizeBytes: uploaded.sizeBytes,
          mimeType: uploaded.contentType,
        },
      ],
      targets: g.targets,
      when: { mode: "draft" as const },
      libi: { pieceId: params.pieceId, pieceName: piece.body.name, exportFile: uploaded.filename },
      exportPath: g.exportPath,
      createdBy: "agent" as const,
    };
    const created = await api<{ post: { id: string; status: string }; deduped: boolean }>("/api/social/posts", {
      method: "POST",
      body: JSON.stringify(body),
    });
    if (!created.ok) {
      return failed(created.body.error ?? `create_failed_${created.status}`, created.body.message ?? "the provider refused the draft", {
        requestId,
        exportPath: g.exportPath,
      });
    }
    posts.push({
      providerPostId: created.body.post.id,
      status: created.body.post.status,
      deduped: created.body.deduped === true,
      exportVariant: g.variant,
      exportPath: g.exportPath,
      exported: g.exported,
      reusedExport: g.reusedExport ? { exportPath: g.exportPath, completedAt: g.reusedExport.completedAt } : null,
      uploaded: { publicUrl: uploaded.publicUrl, expiresAt: uploaded.expiresAt },
      targets: g.targets.map((t) => ({ platform: t.platform, accountId: t.accountId })),
    });
  }
  const first = posts[0];

  // The route already emitted the analytics event with source "agent" — do not
  // track it again here, or every agent draft counts twice.
  const navigated = await notify.navigateAwaited({ target: "posting", pieceId: params.pieceId, id: first.providerPostId });
  logger.info(
    {
      tag: "social",
      op: "post_piece",
      pieceId: params.pieceId,
      providerPostId: first.providerPostId,
      posts: posts.length,
      exported: first.exported,
      reusedExport: !!first.reusedExport,
      deduped: first.deduped,
      targets: targets.map((t) => t.platform),
      navigated,
    },
    "draft created from piece",
  );

  return {
    success: true,
    data: {
      // The FIRST draft, as before; `posts` has every one.
      providerPostId: first.providerPostId,
      status: first.status,
      deduped: first.deduped,
      exported: first.exported,
      reusedExport: first.reusedExport,
      exportPath: first.exportPath,
      uploaded: first.uploaded,
      fit: prepared.flatMap((g) => g.fit),
      posts,
      targets: targets.map((t) => {
        const p = planOf(t)?.plan;
        return {
          platform: t.platform,
          accountId: t.accountId,
          ...(p
            ? {
                plan: {
                  mode: p.mode,
                  sentence: p.sentence,
                  warnings: p.warnings,
                  ...(p.needs ? { needs: p.needs } : {}),
                  ...(p.needsChoice ? { needsChoice: true } : {}),
                },
              }
            : {}),
        };
      }),
      // Any music the plan decides about — a copyrighted song, or the piece's
      // own generated / owned track — has a sentence the user should hear.
      ...(planBody.hasMusic && targets.some((t) => planOf(t))
        ? { music: "Relay each target's plan.sentence and its warnings to the user before they publish. A needsChoice target should have been settled with libi.social_music_search before this call; once a draft exists, the user changes its music on the piece's Posting tab, not a second post_piece call." }
        : {}),
      navigated,
      postingContract: POSTING_CONTRACT,
      // `navigated` is the studio having ACCEPTED the navigate POST — not a
      // screen having changed, and only the editor page listens for it. So
      // the sentence that claims the tab is open is only written when the
      // POST landed; otherwise say where the post is, the way
      // `libi.show_extension` does (manual → `navigate`). Claiming "it is
      // open" to a user looking at the Social page, or at no libi window at
      // all, sends them hunting for something that never moved.
      next: `This is a DRAFT — nothing is public.${
        posts.some((p) => p.reusedExport)
          ? " It reused the piece's most recent export, which libi cannot tell is up to date: name that file to the user and offer to re-export."
          : ""
      }${
        params.exportPath && planBody.copyrighted && posts.some((p) => p.exportPath !== params.exportPath)
          ? givenFor
            ? ` The exportPath you gave went only to the ${givenFor} draft, whose plan its audio fits; libi exported the rest as each plan needs.`
            : " The exportPath you gave was not used: its audio fits no target's music plan, so libi exported what each plan needs."
          : ""
      }${
        posts.length > 1
          ? ` It made ${posts.length} linked drafts, one per export: ${posts
              .map((p) => `${p.exportVariant === "with-song" ? "with the song" : "without the song"} (${p.targets.map((t) => t.platform).join(", ")})`)
              .join("; ")}.`
          : ""
      } ${
        navigated
          ? "It is open in the piece's Posting tab (and Social → Posts)."
          : "Find it in the piece's Posting tab, or on the Social page under Posts."
      } Tell the user in one line; publish or schedule only on their explicit yes.`,
    },
  };
}

/**
 * Link a post the AGENT created with its own zernio tools to the piece it came
 * from, so it shows in the Posting tab and on the Social page — and open that
 * tab. Records a link; it never creates, edits or publishes a post.
 */
export async function socialLinkPost(params: SocialLinkPostParams): Promise<ToolResult> {
  const r = await api<{ ok: true }>("/api/social/links", {
    method: "POST",
    body: JSON.stringify({
      pieceId: params.pieceId,
      providerPostId: params.providerPostId,
      ...(params.exportPath ? { exportPath: params.exportPath } : {}),
      createdBy: "agent",
    }),
  });
  if (!r.ok) {
    const error =
      r.status === 404
        ? "piece_not_found"
        : r.status === 409
          ? "no_provider"
          : r.status === 0
            ? "libi_server_unavailable"
            : (r.body.error ?? `link_failed_${r.status}`);
    return {
      success: false,
      error,
      data: {
        hint:
          error === "piece_not_found"
            ? "libi.list_pieces shows the valid ids."
            : error === "no_provider"
              ? "No social provider is chosen — call libi.suggest_provider({ kind: \"social\" }) and stop."
              : (r.body.message ?? "libi could not record the link."),
      },
    };
  }
  const navigated = await notify.navigateAwaited({ target: "posting", pieceId: params.pieceId, id: params.providerPostId });
  logger.info(
    { tag: "social", op: "link_post", pieceId: params.pieceId, providerPostId: params.providerPostId, navigated },
    "linked a provider post to a piece",
  );
  let postingTabUrl: string | null = null;
  try {
    postingTabUrl = `${studioBase()}/editor`;
  } catch {
    postingTabUrl = null;
  }
  return {
    success: true,
    data: {
      linked: true,
      navigated,
      postingTabUrl,
      next: "The post now shows in the piece's Posting tab and on the Social page. Linking changes nothing at the provider.",
    },
  };
}

/**
 * Attribute an ad the AGENT created to the piece its creative came from.
 *
 * Deliberately narrow: this is for a "dark post" — a piece that went out
 * straight to an ad account and never existed as an organic post. An ad that
 * BOOSTS one of the piece's posts is discovered from the provider's own
 * `effective_instagram_media_id` on every read, so it must not be linked here;
 * storing a row for it would duplicate an answer libi already has, and lose
 * which post it boosts.
 */
export async function socialLinkAd(params: SocialLinkAdParams): Promise<ToolResult> {
  const r = await api<{ ok: true }>("/api/social/ad-links", {
    method: "POST",
    body: JSON.stringify({
      pieceId: params.pieceId,
      providerAdId: params.providerAdId,
      ...(params.platformAdId ? { platformAdId: params.platformAdId } : {}),
      createdBy: "agent",
    }),
  });
  if (!r.ok) {
    const error =
      r.status === 404
        ? "piece_not_found"
        : r.status === 409
          ? "no_provider"
          : r.status === 0
            ? "libi_server_unavailable"
            : (r.body.error ?? `link_failed_${r.status}`);
    return {
      success: false,
      error,
      data: {
        hint:
          error === "piece_not_found"
            ? "libi.list_pieces shows the valid ids."
            : error === "no_provider"
              ? 'No social provider is chosen — call libi.suggest_provider({ kind: "social" }) and stop.'
              : (r.body.message ?? "libi could not record the link."),
      },
    };
  }
  const navigated = await notify.navigateAwaited({ target: "posting", pieceId: params.pieceId });
  logger.info(
    { tag: "social", op: "link_ad", pieceId: params.pieceId, providerAdId: params.providerAdId, navigated },
    "linked a provider ad to a piece",
  );
  return {
    success: true,
    data: {
      linked: true,
      navigated,
      next: "The ad now shows in the piece's Posting tab. Linking changes nothing at the provider, and libi reads ads only — it never creates, pauses or funds one.",
    },
  };
}
