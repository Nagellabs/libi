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
import { randomUUID } from "node:crypto";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol";
import type { ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types";
import { mcpLogger as logger } from "@/lib/logger";
import { getCurrentPort } from "@/lib/libi-home";
import { notify } from "@/mcp/notify";
import { runJobViaServer } from "@/mcp/jobs-client";
import { exportVideo } from "@/mcp/tools/export-tools";
import { fetchConnectedProviders } from "@/mcp/tools/provider-http";
import type { ToolResult } from "./types";
import type { PostPieceParams, SocialLinkPostParams, SocialLinkAdParams } from "./schemas";
import type { SocialAccount, TikTokCreatorInfo, CreatePostInput, TargetOptions } from "@/lib/social/types";
import { exportFingerprint } from "@/lib/social/export-fingerprint";
import type { FitVerdict } from "@/lib/social/fit-check";
import type { SocialUploadResult } from "@/lib/jobs/runners/social-upload";

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

const base = (): string => `http://127.0.0.1:${getCurrentPort()}`;

type ApiResult<T> =
  | { ok: true; body: T }
  | { ok: false; status: number; body: { error?: string; message?: string } };

/**
 * One studio call. Never throws: an unreachable studio comes back as
 * `status: 0`, which every caller maps to `libi_server_unavailable` rather
 * than a tool crash the agent cannot act on.
 */
async function api<T>(path: string, init?: RequestInit): Promise<ApiResult<T>> {
  let url: string;
  try {
    url = `${base()}${path}`;
  } catch (err) {
    return { ok: false, status: 0, body: { message: err instanceof Error ? err.message : String(err) } };
  }
  try {
    const res = await fetch(url, {
      ...init,
      headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
      signal: AbortSignal.timeout(30_000),
    });
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    return res.ok
      ? { ok: true, body: body as T }
      : { ok: false, status: res.status, body: body as { error?: string; message?: string } };
  } catch (err) {
    return { ok: false, status: 0, body: { message: err instanceof Error ? err.message : String(err) } };
  }
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

interface ExportJobRow {
  pieceId: string | null;
  status: string;
  resultJson: string | null;
  completedAt: string | null;
}

/**
 * This piece's most recent completed export that is still on disk — the same
 * rows the Posting tab reads (`GET /api/jobs?kind=export`).
 *
 * Reused rather than re-rendered because an export runs for minutes and the
 * agent has usually just made one. `/api/export` always forces a fresh job, so
 * this is the only place the reuse can happen — and it is why the result says
 * `exported: false` with the file's age: the agent must tell the user WHICH
 * file is being posted, since libi cannot know whether the piece changed after
 * that render.
 */
async function latestExportFor(pieceId: string): Promise<{ path: string; completedAt: string | null } | null> {
  const jobs = await api<{ jobs: ExportJobRow[] }>("/api/jobs?kind=export&status=completed&limit=100");
  if (!jobs.ok) return null;
  const rows = (jobs.body.jobs ?? [])
    .filter((j) => j.pieceId === pieceId && j.status === "completed" && !!j.resultJson)
    .flatMap((j) => {
      let parsed: { filePath?: unknown };
      try {
        parsed = JSON.parse(j.resultJson as string) as { filePath?: unknown };
      } catch {
        return [];
      }
      return typeof parsed.filePath === "string" ? [{ path: parsed.filePath, completedAt: j.completedAt }] : [];
    })
    .sort((a, b) => new Date(b.completedAt ?? 0).getTime() - new Date(a.completedAt ?? 0).getTime());
  for (const row of rows) {
    // A row whose file the user has since moved or deleted is not an export.
    if (fs.existsSync(row.path)) return row;
  }
  return null;
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

  // --- the export: given, reused, or rendered now (progress on this call) ---
  let exportPath = params.exportPath;
  let exported = false;
  let reusedExport: { path: string; completedAt: string | null } | null = null;
  if (!exportPath) {
    reusedExport = await latestExportFor(params.pieceId);
    if (reusedExport) {
      exportPath = reusedExport.path;
    } else {
      const ex = await exportVideo({ pieceId: params.pieceId, quality: "source" }, extra);
      if (!ex.success) return { success: false, error: "export_failed", data: ex.data as Record<string, unknown> };
      exportPath = ex.data.filePath;
      exported = true;
    }
  }

  // --- does it fit? local, offline, before anything leaves the machine ---
  const fit = await api<{ verdicts: FitVerdict[] }>("/api/social/fit", {
    method: "POST",
    body: JSON.stringify({ exportPath, targets: targets.map((t) => ({ platform: t.platform, postType: postTypeOf(t) })) }),
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
  const bad = fit.body.verdicts.filter((v) => !v.ok);
  if (bad.length > 0) {
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

  // --- upload (a job, so progress lands on this tool call) ---
  let uploaded: SocialUploadResult;
  try {
    const up = await runJobViaServer<SocialUploadResult>(
      "social-upload",
      {
        providerId: st.body.providerId,
        exportPath,
        pieceId: params.pieceId,
        // Part of the job's dedupe key, so a completed upload of THIS file is
        // reused and a re-export to the same path is not (see
        // `exportFingerprint`). `post_piece` already relied on that reuse —
        // without the fingerprint it would happily post last render's bytes.
        fileFingerprint: exportFingerprint(exportPath),
      },
      { extra, pieceId: params.pieceId },
    );
    uploaded = up.status === "matching_completed" ? (up.existingJob.result as SocialUploadResult) : up.result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn({ tag: "social", op: "post_piece.upload_failed", pieceId: params.pieceId, err: message }, "upload failed");
    return { success: false, error: "upload_failed", data: { hint: message, exportPath } };
  }
  if (!uploaded?.publicUrl) {
    return { success: false, error: "upload_failed", data: { hint: "the upload job returned no URL", exportPath } };
  }

  // --- the DRAFT. `when` is a constant here, and there is no other branch ---
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
    targets,
    when: { mode: "draft" as const },
    libi: { pieceId: params.pieceId, pieceName: piece.body.name, exportFile: uploaded.filename },
    exportPath,
    createdBy: "agent" as const,
  };
  const created = await api<{ post: { id: string; status: string }; deduped: boolean }>("/api/social/posts", {
    method: "POST",
    body: JSON.stringify(body),
  });
  if (!created.ok) {
    return {
      success: false,
      error: created.body.error ?? `create_failed_${created.status}`,
      data: { hint: created.body.message ?? "the provider refused the draft", requestId, exportPath },
    };
  }

  // The route already emitted the analytics event with source "agent" — do not
  // track it again here, or every agent draft counts twice.
  const navigated = await notify.navigateAwaited({ target: "posting", pieceId: params.pieceId, id: created.body.post.id });
  logger.info(
    {
      tag: "social",
      op: "post_piece",
      pieceId: params.pieceId,
      providerPostId: created.body.post.id,
      exported,
      reusedExport: !!reusedExport,
      deduped: created.body.deduped,
      targets: targets.map((t) => t.platform),
      navigated,
    },
    "draft created from piece",
  );

  return {
    success: true,
    data: {
      providerPostId: created.body.post.id,
      status: created.body.post.status,
      deduped: created.body.deduped === true,
      exported,
      reusedExport: reusedExport
        ? { exportPath, completedAt: reusedExport.completedAt }
        : null,
      exportPath,
      uploaded: { publicUrl: uploaded.publicUrl, expiresAt: uploaded.expiresAt },
      fit: fit.body.verdicts,
      targets: targets.map((t) => ({ platform: t.platform, accountId: t.accountId })),
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
        reusedExport
          ? " It reused the piece's most recent export, which libi cannot tell is up to date: name that file to the user and offer to re-export."
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
    postingTabUrl = `${base()}/editor`;
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
