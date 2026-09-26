/**
 * `template_publish` — put a local template in the public catalog. Only the
 * user starts it: the Templates page's review panel confirms a publish request
 * an agent prepared with `libi.publish_template`, and the confirm route
 * enqueues this job in-process (lib/templates/cloud/publish-confirm.ts).
 * `POST /api/jobs` never starts it and `/api/jobs/:id/retry` never re-runs it
 * (lib/jobs/user-started-kinds.ts). The job publishes only the content the
 * user reviewed (`reviewedFingerprint`: the template's content plus the
 * sha256 of the request's example and poster).
 *
 *   1. preflight   every catalog rule that does not need the media, before
 *                  anything slow or anything that talks to the site;
 *   2. identity    the creator key (made on first publish); a nickname passed
 *                  with the publish is sent only just before prepare (5);
 *   3. media       the example.mp4 and poster.jpg the REQUEST prepared
 *                  (lib/templates/cloud/publish-request-media.ts) — exactly
 *                  the bytes the user reviewed, read once, hashed against the
 *                  review and sent as read; nothing is exported or
 *                  transcoded here;
 *   4. preflight   again, now complete — the same rules the site enforces;
 *   5. prepare     the site signs one upload URL per file;
 *   6. upload      each file, byte-checked against the manifest first;
 *   7. commit      the site verifies the staged bytes and makes them live;
 *   8. record      the row gains its cloud id; the example and poster become
 *                  the local template's own (`markTemplatePublished`).
 *
 * The body is built once and sent to prepare and commit alike. Its metadata
 * is the ROW's (the listing shows it, and the site requires the scaffold's
 * copy to equal it), `template.json` is uploaded as exactly
 * `JSON.stringify` of the schema-parsed scaffold in the body, and `index.md`
 * as exactly the UTF-8 of `instructions` (LF only, no BOM): commit binds the
 * staged bytes to what prepare validated.
 *
 * The creator key travels only inside the client's Authorization header; it is
 * never logged here, and the client scrubs it from every error it returns.
 */
import fsp from "node:fs/promises";
import path from "node:path";
import { z } from "zod/v3";
import { trackServerEvent } from "@/lib/analytics/server";
import { getOrCreateTemplatesAuthor, getTemplatesAuthor, setTemplatesAuthorNickname } from "@/lib/db/settings";
import { CancelledError, type JobContext, type JobRunner } from "@/lib/jobs/types";
import { serverLogger as logger } from "@/lib/logger";
import { navigationEmitter } from "@/lib/navigation-events";
import {
  definitiveRefusal,
  isCreatorNotApproved,
  isGlobalCap,
  isPublishBusy,
  isPublishingPaused,
  mineShowsLive,
  nextUtcDay,
  publishCommit,
  publishPrepare,
  refusalMessage,
  setNickname,
  uploadSigned,
  type CloudFail,
} from "@/lib/templates/cloud/client";
import { noteOwnCatalogChange } from "@/lib/templates/cloud/catalog-cache";
import { CREATOR_NOT_APPROVED_MESSAGE, CREATOR_STATUS_REFRESH_KEY, NICKNAME_PATTERN } from "@/lib/templates/cloud/constants";
import { hasCodeIn, manifestEntryFor, md5Base64, preflightPublish, type ExampleMeta, type ManifestEntry, type PreflightFile } from "@/lib/templates/cloud/preflight";
import {
  CHANGED_SINCE_REVIEW,
  commitRequestBytes,
  contentFingerprint,
  earlyPreflightReasons,
  EXAMPLE_FILE,
  INSTRUCTIONS_FILE,
  manifestOf,
  POSTER_FILE,
  preflightRefusal,
  publishBodyOf,
  readPublishContent,
  SCAFFOLD_FILE,
  VERSION_STANDIN,
} from "@/lib/templates/cloud/publish-content";
import { readBackExample } from "@/lib/templates/cloud/publish-media";
import { isPublishRequestId, mediaDigest, readRequestMedia } from "@/lib/templates/cloud/publish-request-media";
import { publishRequestSource } from "@/lib/templates/cloud/publish-requests";
import { catalogSource, withCatalogSource } from "@/lib/templates/cloud/catalog-source";
import {
  allUploaded,
  clearPublishPending,
  getPublishPending,
  hasPublishPending,
  markTemplatePublished,
  publishWorkDir,
  setPublishPending,
  unansweredCommitMayRun,
  type PublishPending,
} from "@/lib/templates/store";

const TAG = "templates-cloud";

const paramsSchema = z.object({
  templateId: z.string().min(1),
  /** The publish request the user confirmed: its folder holds the example and poster this job sends. */
  requestId: z.string().refine(isPublishRequestId, "not a publish request id"),
  /** Mirrors the site's nickname rule (libi-site lib/templates/constants.ts#NICKNAME_PATTERN), trimmed. */
  nickname: z.string().trim().regex(NICKNAME_PATTERN, "nickname: 2–32 letters, digits, spaces, - or _").optional(),
  /**
   * The content the user reviewed and confirmed on the Templates page
   * (`contentFingerprint` of the publish request: the template plus the
   * request's example and poster). The job publishes only that: a template or
   * a media file changed since is refused before anything leaves the machine.
   * Only the confirm route starts this job (`POST /api/jobs` refuses the kind).
   */
  reviewedFingerprint: z.string().regex(/^[0-9a-f]{64}$/),
});
export type TemplatePublishParams = z.infer<typeof paramsSchema>;
export interface TemplatePublishResult {
  cloudId: string;
  version: number;
  exampleBytes: number;
}

const IDENTITY_CHANGED = "the creator identity changed while it was being saved — try again";
const RESERVED_UNDER_OTHER_KEY = "This template's id is reserved under another creator key: import that key again to publish under it, or discard the pending publish (Templates page, \"Publishing as\") to publish it under a new id.";
const NICKNAME_CHANGED = "Your public nickname changed while this publish was sending it, so nothing was published. Check the name under \"Publishing as\" on the Templates page, then publish again.";
const NICKNAME_FIRST = 'Set a nickname first — under "Publishing as" on the Templates page, or ask the agent to prepare the publish again with one.';
const REQUEST_MEDIA_GONE = "The example video prepared for this publish is gone — ask the agent to prepare it again.";

/** Throws CancelledError when the job was cancelled. */
function checkCancel(ctx: JobContext<TemplatePublishParams>): void {
  if (ctx.shouldCancel()) throw new CancelledError(ctx.jobId);
}

/** A signed URL this close to expiry is not worth starting an upload on. */
const RESUME_MARGIN_MS = 60_000;
/**
 * Waits between commit attempts that got no verdict: no answer, a 5xx, or the
 * site's "being published right now" 409 (a commit of the same publish still
 * running). Each send waits COMMIT_TIMEOUT_MS (the site's 60 s `maxDuration`
 * plus a margin, lib/templates/cloud/client.ts), so a send that got no answer
 * has already ended on the site. A commit is safe to send again: the site
 * answers a replay of one that landed with the same success.
 */
const COMMIT_RETRY_DELAYS_MS = [2_000, 4_000, 8_000, 16_000];

function manifestIn(body: Record<string, unknown>): ManifestEntry[] {
  return Array.isArray(body.files) ? (body.files as ManifestEntry[]) : [];
}

/**
 * Worth sending the same commit again: nothing says it will not land. The
 * site's own 503 `publishing_paused` is an answer, not a lack of one: every
 * send until the operator resumes publishing gets it, so it is not re-sent.
 */
function noVerdict(r: CloudFail): boolean {
  return (r.status === undefined || r.status >= 500 || isPublishBusy(r)) && !isPublishingPaused(r);
}

/**
 * The request may not have finished on the site: no answer came, or only an
 * intermediary's (5xx). A `publishing_paused` refusal is the site's, sent
 * before it touches anything — that request is over.
 */
function mayStillRun(r: CloudFail): boolean {
  return (r.status === undefined || r.status >= 500) && !isPublishingPaused(r);
}

/**
 * A refusal that is not a verdict on the publish, as the creator hears it:
 * the site's words (libi's for `moderated`), plus when trying again can help
 * where the code decides that. `pendingKept`: the refused call was a commit,
 * and its pending publish stays on the row for the next attempt to replay.
 *   - `caps_global`: the catalog-wide daily cap. Every attempt before the next
 *     UTC day gets the same answer, and nothing in libi retries it — the
 *     commit loop re-sends only on no verdict — so the words name that time
 *     and ask for no retry before it.
 *   - `publishing_paused`: the operator's kill switch; the site's words say
 *     nothing was published and to try later. The pending publish is kept,
 *     and a replay once publishing resumes gets its receipt (the site keeps
 *     them 7 days).
 *   - `creator_not_approved`: the key is not an approved creator (publishing
 *     is invite-only); libi's words say to apply on the Templates page. On a
 *     commit the pending publish is kept, but the site holds a prepared
 *     publish for only an hour (libi-site PENDING_PUBLISH_TTL_MS) and approval
 *     is a manual review — so the words promise the same publish only within
 *     that hour; a retry after it gets `expired` / `nothing_pending`, which
 *     abandons the pending publish, and the next attempt starts over. A 403 is
 *     never re-sent (only no verdict is).
 */
const KEPT = " libi kept this publish: trying again finishes this same one, under the same id.";
/** The site keeps a prepared publish one hour; an approval can take longer. */
const KEPT_UNTIL_APPROVED =
  " libi kept this publish, but the catalog holds it for only an hour after it was prepared: if you're approved within that hour, trying again finishes this same one, under the same id; after that, trying again starts the publish over.";

/**
 * The creator's approval, as the Templates page last read it, is now known to
 * be wrong or stale: tell the page to re-read it (only it — never the whole
 * `templates` prefix, which would spend the site's `creators` budget).
 */
function refreshCreatorStatus(): void {
  navigationEmitter.emit("refresh_query", { queryKey: CREATOR_STATUS_REFRESH_KEY });
}

function notYetMessage(r: CloudFail, pendingKept: boolean, now = Date.now()): string {
  const words = refusalMessage(r);
  const kept = !pendingKept ? "" : isCreatorNotApproved(r) ? KEPT_UNTIL_APPROVED : KEPT;
  if (isGlobalCap(r)) {
    return `${words}${kept} Don't try again before ${nextUtcDay(now).toISOString().replace(".000Z", "Z")} (00:00 UTC) — until then the catalog refuses every attempt.`;
  }
  return isPublishingPaused(r) || isCreatorNotApproved(r) ? `${words}${kept}` : words;
}

/**
 * Send the commit once. The send is recorded on the row BEFORE it goes out (a
 * crash mid-request counts as unanswered) and withdrawn once the site answers
 * in a way that means this request is over.
 */
async function sendCommit(templateId: string, key: string, pending: PublishPending) {
  const before = pending.unansweredCommitAt;
  pending.unansweredCommitAt = Date.now();
  setPublishPending(templateId, pending);
  const answer = await publishCommit(key, pending.body);
  if (answer.ok || !mayStillRun(answer)) {
    pending.unansweredCommitAt = before;
    setPublishPending(templateId, pending);
  }
  return answer;
}

/** Commit, sending it again (it is idempotent) while the site gives no verdict. */
async function commitWithRetries(ctx: JobContext<TemplatePublishParams>, key: string, pending: PublishPending) {
  let answer = await sendCommit(ctx.params.templateId, key, pending);
  for (const delay of COMMIT_RETRY_DELAYS_MS) {
    if (answer.ok || !noVerdict(answer)) break;
    await new Promise((resolve) => setTimeout(resolve, delay));
    ctx.reportProgress(96, 100, "%");
    answer = await sendCommit(ctx.params.templateId, key, pending);
  }
  return answer;
}

const MAY_HAVE_LANDED = "The template may already be published — try again to finish: libi will complete this same publish, never make a second one.";

/** The error a publish stopped for `needsAttention` gives, on the attempt that finds it and on every retry. */
function needsAttentionError(reason: string): Error {
  return new Error(
    `This template's publish needs attention: ${reason}. libi has stopped retrying it, so it can't make a second copy. Discard the pending publish (Templates page, "Publishing as"), then ask the agent to prepare the publish again.`,
  );
}

/** A pending publish a retry may still finish — one whose bytes it needs. An unreadable record counts. */
function resumablePending(templateId: string): boolean {
  if (!hasPublishPending(templateId)) return false;
  try {
    return getPublishPending(templateId)?.abandoned !== true;
  } catch {
    return true;
  }
}

type Finished = { published: { cloudId: string; version: number; indexed: boolean } } | { dead: true };

/**
 * This publish can never go live: kept, marked `abandoned`, for its id alone —
 * the next prepare asks for it again (store.ts#PublishPending.abandoned).
 */
function abandonPending(templateId: string, pending: PublishPending, why: string): void {
  // Already abandoned on an earlier attempt: nothing changes, and nothing is newly given up.
  if (pending.abandoned) return;
  setPublishPending(templateId, { ...pending, abandoned: true });
  logger.info({ tag: TAG, op: "pending_abandoned", templateId, cloudId: pending.cloudId, version: pending.version, why }, "pending publish can never land; its id is kept for the next prepare");
}

/**
 * Upload what `pending` has not uploaded yet, then commit its body, recording
 * each upload on the row.
 *
 * The publish is given up only on proof that it can never go live:
 *   - no commit of it was ever sent (a RESUMED attempt whose bytes are gone or
 *     changed, or whose signed URL the bucket refused, before its last upload);
 *   - or the site refused the commit DEFINITIVELY, by code (`definitiveRefusal`:
 *     expired, wrong version; "nothing pending" only once no earlier commit of
 *     it may still be running) AND the creator's own list, read fail-closed,
 *     shows the id not live at this version.
 * Then a resumed attempt returns `{ dead: true }` (the caller prepares again)
 * and a first attempt marks the record `abandoned` and throws the refusal.
 * Either way the record — and so the id — is kept: the next prepare asks for
 * the same id, so even a wrong "not live" from the list cannot mint a second
 * public template.
 *
 * `replay_mismatch` says this version IS live (from another body): never
 * given up — marked `needsAttention` when the list, read, does not show it.
 *
 * Anything else — no answer, a 5xx, a 429, a 400, a refusal while an earlier
 * send may still land, a list that could not be read — throws and KEEPS the
 * record as it is: the next attempt replays the same commit, which the site
 * answers idempotently.
 */
async function finishPending(
  ctx: JobContext<TemplatePublishParams>,
  key: string,
  pending: PublishPending,
  bytesOf: (name: string) => Promise<Buffer | null>,
  resumed: boolean,
): Promise<Finished> {
  const { templateId } = ctx.params;
  const declared = new Map(manifestIn(pending.body).map((m) => [m.name, m]));
  const todo = pending.uploads.filter((u) => !pending.uploaded.includes(u.name));
  for (const up of todo) {
    checkCancel(ctx);
    const entry = declared.get(up.name);
    if (!entry) throw new Error(`the catalog signed an upload for ${up.name}, which is not in this publish`);
    const buf = await bytesOf(up.name);
    if (!buf || buf.byteLength !== entry.bytes || md5Base64(buf) !== entry.md5) {
      if (resumed) return { dead: true };
      throw new Error(`${up.name} changed while it was being published — try again`);
    }
    const r = await uploadSigned(up, buf);
    if (!r.ok) {
      if (resumed && r.status !== undefined) return { dead: true };
      throw new Error(`upload of ${up.name} failed: ${r.error}`);
    }
    pending.uploaded.push(up.name);
    setPublishPending(templateId, pending);
    ctx.reportProgress(72 + Math.round((pending.uploaded.length / pending.uploads.length) * 23), 100, "%");
  }
  await ctx.checkpoint({ step: "uploaded", cloudId: pending.cloudId, version: pending.version });

  // No cancel past here: the site may already have made it live.
  const committed = await commitWithRetries(ctx, key, pending);
  if (committed.ok) {
    if (committed.templateId !== pending.cloudId || committed.version !== pending.version) {
      // Replaying would only get the same answer: stop, and say so on every retry until the creator discards it.
      const reason = `the catalog answered it with template ${committed.templateId} v${committed.version}, not ${pending.cloudId} v${pending.version}, the one it prepared`;
      setPublishPending(templateId, { ...pending, needsAttention: reason });
      logger.warn({ tag: TAG, op: "pending_needs_attention", templateId, cloudId: pending.cloudId, version: pending.version, answeredId: committed.templateId, answeredVersion: committed.version }, "commit answered for another template or version");
      throw needsAttentionError(reason);
    }
    return { published: { cloudId: committed.templateId, version: committed.version, indexed: committed.indexed } };
  }
  if (noVerdict(committed)) throw new Error(`The catalog did not confirm the publish (${committed.error}). ${MAY_HAVE_LANDED}`);

  // A refusal. An EARLIER send of this commit (one whose answer never came)
  // may have landed; the creator's own list says whether it did — the site's
  // own test: the id at this version or later.
  const mine = await mineShowsLive(key, pending.cloudId, pending.version);
  if (mine.ok && mine.live) return { published: { cloudId: pending.cloudId, version: pending.version, indexed: true } };

  const refusal = definitiveRefusal(committed);
  if (refusal === "replay_mismatch") {
    // The site holds a committed receipt for this (id, version): it IS live. A
    // list that cannot be read may show it next time; one that was read and
    // does not is a contradiction no replay will resolve.
    if (!mine.ok) throw new Error(`${committed.error} (libi could not check the creator's list: ${mine.error}) — try again`);
    const reason = `the catalog says ${pending.cloudId} v${pending.version} is already published, from a different body, but the creator's list does not show it`;
    setPublishPending(templateId, { ...pending, needsAttention: reason });
    logger.warn({ tag: TAG, op: "pending_needs_attention", templateId, cloudId: pending.cloudId, version: pending.version, code: refusal }, "replay mismatch the creator's list does not show");
    throw needsAttentionError(reason);
  }
  // Another key's refusal is final for THIS key, but this key's list cannot
  // see that key's templates: nothing proves the earlier send did not land.
  const proven = refusal !== null && refusal !== "forbidden" && !(refusal === "nothing_pending" && unansweredCommitMayRun(pending));
  if (!proven) {
    if (refusal === "nothing_pending") throw new Error(`The catalog has no record of this publish yet. ${MAY_HAVE_LANDED}`);
    if (refusal === "forbidden") {
      throw new Error(`${committed.error} This publish was started under another creator key: import that key again to finish it.`);
    }
    // Not a verdict on the commit (a 429, a 400, a cap, publishing paused): the record stays, and the next attempt's replay gets one.
    if (isCreatorNotApproved(committed)) refreshCreatorStatus();
    throw new Error(notYetMessage(committed, true));
  }
  if (!mine.ok) throw new Error(`${committed.error} (libi could not check whether an earlier attempt landed: ${mine.error}) — try again`);
  if (resumed) return { dead: true };
  abandonPending(templateId, pending, refusal);
  throw new Error(refusalMessage(committed));
}

export const templatePublishRunner: JobRunner<TemplatePublishParams, TemplatePublishResult> = {
  kind: "template_publish",
  maxConcurrent: 1,
  paramsSchema: paramsSchema as unknown as z.ZodSchema<TemplatePublishParams>,
  // JobManager never resumes a job (a restart marks it failed); what a retry
  // resumes is the pending publish on the TEMPLATE row. The checkpoints below
  // are progress records only.
  resumable: false,
  // One template's publish at a time: a double submit attaches to the run in
  // flight rather than racing it over the same pending publish and folder.
  exclusiveResource: true,
  // Uploads of up to 24 MB on a slow link go quiet; the client's own timeouts bound each call.
  noProgressTimeoutMs: 180_000,
  // No `mcpToolId`: no tool call runs this job — the user's confirm does.
  // Pinned to the catalog its request was prepared for (a dev build can switch
  // catalogs in Settings): every call, record and cache note below stays there.
  async run(ctx) {
    return withCatalogSource(publishRequestSource(ctx.params.requestId) ?? catalogSource(), () => runPublish(ctx));
  },
};

async function runPublish(ctx: JobContext<TemplatePublishParams>): Promise<TemplatePublishResult> {
  const { templateId } = ctx.params;
  // --- 1. What will be sent (publish-content.ts), and the preflight that needs no media ---
  // A link to another catalog reads as none (a throwaway one is replaced by
  // this publish, store.ts#setPublishPending); a production link is refused.
  const content = await readPublishContent(templateId);
  const { row, dir, meta, parsed, scaffoldBytes, instructionsBytes, baseFiles } = content;
  // What the user reviewed on the Templates page, and nothing else: these
  // buffers are hashed here and are the very bytes uploaded below.
  const media = await readRequestMedia(ctx.params.requestId);
  if (!media) throw new Error(REQUEST_MEDIA_GONE);
  const fingerprint = contentFingerprint(content, mediaDigest(media));
  if (fingerprint !== ctx.params.reviewedFingerprint) throw new Error(CHANGED_SINCE_REVIEW);
  // Read before anything else: an unreadable record must stop the publish, never be taken for "none".
  const pending = getPublishPending(templateId);
  if (pending?.needsAttention) throw needsAttentionError(pending.needsAttention);
  // The id prepare is asked for: a republish's, or a pending first publish's reservation (below).
  let cloudId = row.cloudId;
  /** `cloudId` is a first publish's reserved id: the site may have let it lapse. */
  let reserved = false;

  const bodyOf = (files: ManifestEntry[], example: ExampleMeta) => publishBodyOf(meta, cloudId, files, example);
  const early = earlyPreflightReasons(content, cloudId);
  if (early) throw preflightRefusal(early);
  ctx.reportProgress(2, 100, "%");
  await ctx.checkpoint({ step: "preflight" });

  // --- 2. Identity: the key is made on first publish, with a default nickname (lib/templates/cloud/default-nickname.ts) ---
  let author = getOrCreateTemplatesAuthor();
  if (!author.nickname && !ctx.params.nickname) throw new Error(NICKNAME_FIRST);
  /**
   * A nickname passed with this publish renames EVERY template this install
   * has published, so it reaches the site only once this publish is about to
   * go out: after the complete preflight and the identity re-check (before
   * prepare), or before finishing a pending publish, whose content passed
   * both when it was prepared. A publish refused before then renames nothing.
   */
  let nicknameSent = false;
  const applyNickname = async () => {
    if (nicknameSent || !ctx.params.nickname) return;
    nicknameSent = true;
    const set = await setNickname(author.key, ctx.params.nickname);
    if (!set.ok) throw new Error(`could not set the nickname: ${set.error}`);
    // A key imported while the site answered must not receive this nickname.
    if (!setTemplatesAuthorNickname(author.key, set.nickname)) throw new Error(IDENTITY_CHANGED);
    author = { ...author, nickname: set.nickname };
    checkCancel(ctx);
  };
  /**
   * The site has no nickname for this key (`nickname_required`) and none was
   * passed with this publish: send the stored one — the default this
   * identity was given, or the user's own from before the site lost it. Only
   * on the site's word that it has none, so a nickname the site already
   * shows for this key (set from another machine, say) is never replaced by
   * a local default. Returns whether it sent one, so prepare can be retried.
   *
   * The stored nickname is re-read right before each send, never the one
   * read when the job started: the user may have renamed meanwhile (their
   * rename sets the site first, then this machine). If they rename WHILE it
   * is being sent, the compare-and-set loses and the name they chose — now
   * stored — is sent again, so the site never keeps the default over it.
   * Losing twice stops the publish rather than guess.
   */
  let storedNicknameSent = false;
  const applyStoredNickname = async (): Promise<boolean> => {
    if (nicknameSent || storedNicknameSent) return false;
    storedNicknameSent = true;
    for (let attempt = 0; attempt < 2; attempt++) {
      const now = getTemplatesAuthor();
      if (now?.key !== author.key) throw new Error(IDENTITY_CHANGED);
      if (!now.nickname) return false;
      const set = await setNickname(author.key, now.nickname);
      if (!set.ok) throw new Error(`could not set the nickname: ${set.error}`);
      if (setTemplatesAuthorNickname(author.key, set.nickname, { expectedNickname: now.nickname })) {
        author = { ...author, nickname: set.nickname };
        logger.info({ tag: TAG, op: "stored_nickname_sent", templateId, attempt }, "the catalog had no nickname for this key; sent the stored one");
        checkCancel(ctx);
        return true;
      }
      logger.warn({ tag: TAG, op: "stored_nickname_superseded", templateId, attempt }, "the nickname changed while the stored one was being sent; sending the new one");
    }
    if (getTemplatesAuthor()?.key !== author.key) throw new Error(IDENTITY_CHANGED);
    throw new Error(NICKNAME_CHANGED);
  };
  checkCancel(ctx);
  ctx.reportProgress(5, 100, "%");

  // The example and poster live here from the transcode until the publish
  // lands, so a retry can upload the very bytes prepare signed for.
  const work = publishWorkDir(templateId);
  const examplePath = path.join(work, EXAMPLE_FILE);
  const posterPath = path.join(work, POSTER_FILE);
  const inMemory = new Map<string, Buffer>([[SCAFFOLD_FILE, scaffoldBytes], [INSTRUCTIONS_FILE, instructionsBytes]]);
  const onPath = new Map<string, string>([[EXAMPLE_FILE, examplePath], [POSTER_FILE, posterPath]]);
  const bytesOf = async (n: string) => inMemory.get(n) ?? (await fsp.readFile(onPath.get(n) ?? path.join(dir, n)).catch(() => null));

  /** The publish landed: the row takes its cloud id and media, and the pending record goes. */
  const recordPublished = async (done: { cloudId: string; version: number; indexed: boolean }) => {
    await markTemplatePublished(templateId, { cloudId: done.cloudId, examplePath, posterPath });
    // The cached public index predates this: re-check it, and let the Public tab show the template meanwhile.
    noteOwnCatalogChange({ cloudId: done.cloudId, version: done.version, kind: "published" });
    trackServerEvent("template_published", { hasCode: parsed.ok && hasCodeIn(parsed.scaffold) });
    logger.info({ tag: TAG, op: "published", templateId, cloudId: done.cloudId, version: done.version, indexed: done.indexed }, "template published");
  };

  try {
    // --- A pending publish: finish it, or prove it can never land, before anything else ---
    if (pending) {
      const everyUploadDone = allUploaded(pending);
      const sameContent = pending.fingerprint === fingerprint;
      let finished: Finished = { dead: true };
      // Abandoned: proven never to land, kept for its id alone. All uploaded:
      // a commit may have been sent, so its fate is the site's to say —
      // replayed even when the content changed since. Otherwise no commit was
      // ever sent: finish it while its signed URLs last, or let it go.
      if (!pending.abandoned && (everyUploadDone || (sameContent && pending.expiresAt - RESUME_MARGIN_MS > Date.now()))) {
        ctx.reportProgress(72, 100, "%");
        await ctx.checkpoint({ step: "resumed", cloudId: pending.cloudId, version: pending.version });
        await applyNickname();
        finished = await finishPending(ctx, author.key, pending, bytesOf, true);
      }
      if ("published" in finished) {
        await recordPublished(finished.published);
        if (sameContent) {
          ctx.reportProgress(100, 100, "%");
          const exampleBytes = manifestIn(pending.body).find((f) => f.name === EXAMPLE_FILE)?.bytes ?? 0;
          return { cloudId: finished.published.cloudId, version: finished.published.version, exampleBytes };
        }
        // What landed is the content from before the edit: publish the current content as its next version.
        cloudId = finished.published.cloudId;
      } else {
        // Never going live — but its id is this author's: libi-site keeps a
        // first publish's id reserved (a week from its latest prepare) and
        // answers a prepare of it with fresh URLs at v1. Asking for the same
        // id means a second public template cannot happen, even were this
        // attempt live after all. The record stays until prepare replaces it.
        abandonPending(templateId, pending, "resumed");
        if (!cloudId) {
          cloudId = pending.cloudId;
          reserved = true;
        }
      }
    }

    // --- 3. Media: the request's own files, exactly as reviewed ---
    await fsp.rm(work, { recursive: true, force: true });
    await fsp.mkdir(work, { recursive: true });
    await fsp.writeFile(examplePath, media.example);
    await fsp.writeFile(posterPath, media.poster);
    // Uploaded from these buffers, never re-read: what was hashed is what goes out.
    inMemory.set(EXAMPLE_FILE, media.example);
    inMemory.set(POSTER_FILE, media.poster);
    // The example as the site will judge it (the prepare step made it to fit; this reads it back).
    const example = await readBackExample(examplePath);
    checkCancel(ctx);
    ctx.reportProgress(68, 100, "%");
    await ctx.checkpoint({ step: "media" });

    // --- 4. The complete preflight ---
    const files: PreflightFile[] = [...baseFiles, manifestEntryFor(EXAMPLE_FILE, media.example), manifestEntryFor(POSTER_FILE, media.poster)];
    const exampleMeta = { durationSec: example.durationSec, width: example.width, height: example.height };
    let body = bodyOf(manifestOf(files), exampleMeta);
    const full = preflightPublish({ ...meta, files, example: exampleMeta, bodyBytes: commitRequestBytes(body, cloudId, VERSION_STANDIN) });
    if (!full.ok) throw preflightRefusal(full.reasons);

    // --- 5. Prepare ---
    // An identity imported during the media step owns nothing here: stop rather than publish under a key that is gone.
    if (getTemplatesAuthor()?.key !== author.key) throw new Error(IDENTITY_CHANGED);
    await applyNickname();
    let prep = await publishPrepare(author.key, body);
    if (!prep.ok && prep.code === "nickname_required" && (await applyStoredNickname())) prep = await publishPrepare(author.key, body);
    if (!prep.ok && reserved && prep.status === 404 && prep.code === "not_found") {
      // The reservation lapsed: no template and no reservation under that id,
      // so nothing of it is live or ever can be — the one case a first
      // publish takes a new id.
      logger.info({ tag: TAG, op: "reservation_lapsed", templateId, cloudId }, "reserved id no longer held; preparing a new one");
      clearPublishPending(templateId);
      cloudId = null;
      reserved = false;
      body = bodyOf(manifestOf(files), exampleMeta);
      prep = await publishPrepare(author.key, body);
    }
    if (!prep.ok) {
      if (prep.code === "nickname_required") throw new Error(NICKNAME_FIRST);
      // Invite-only: a verdict on this creator key, not on the publish — never retried.
      if (isCreatorNotApproved(prep)) {
        refreshCreatorStatus();
        throw new Error(CREATOR_NOT_APPROVED_MESSAGE);
      }
      // A reservation held under another creator key (a key imported since): every retry would get
      // the same answer, so name the two ways out, as the commit path does.
      if (reserved && prep.code === "forbidden") throw new Error(`${prep.error} ${RESERVED_UNDER_OTHER_KEY}`);
      throw new Error(notYetMessage(prep, false));
    }
    if (cloudId && prep.templateId !== cloudId) {
      // Asked for one id (a republish's, or a reservation) and answered for another.
      throw new Error(`the catalog answered for a different template than ${cloudId}, the one being published — nothing was uploaded`);
    }
    // Recorded BEFORE any upload: from here the site has an id for this
    // template, and a timeout, a crash or a restart must not lose it.
    const next: PublishPending = {
      cloudId: prep.templateId,
      version: prep.version,
      expiresAt: prep.expiresAt,
      body: { ...body, templateId: prep.templateId, version: prep.version },
      uploads: prep.uploads,
      uploaded: [],
      fingerprint,
      authorId: author.authorId,
    };
    setPublishPending(templateId, next);
    checkCancel(ctx);
    ctx.reportProgress(72, 100, "%");
    await ctx.checkpoint({ step: "prepared", cloudId: prep.templateId, version: prep.version, expiresAt: prep.expiresAt });

    // --- 6. Upload, each file exactly as declared; 7. commit ---
    const finished = await finishPending(ctx, author.key, next, bytesOf, false);
    // Only a resumed attempt reports a dead publish.
    if (!("published" in finished)) throw new Error("the publish could not be finished — try again");

    // --- 8. Record ---
    await recordPublished(finished.published);
    ctx.reportProgress(100, 100, "%");
    return { cloudId: finished.published.cloudId, version: finished.published.version, exampleBytes: media.example.byteLength };
  } finally {
    // Kept while a publish may still be finished: a retry needs these exact bytes.
    if (!resumablePending(templateId)) await fsp.rm(work, { recursive: true, force: true });
  }
}
