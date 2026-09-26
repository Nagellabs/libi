/**
 * Publish requests: "an agent can prepare a publish; only you can publish."
 *
 * `libi.publish_template` no longer publishes. It runs the local preflight
 * (`checkPublishRequestable`), then its `template_publish_prepare` job makes
 * the request's own example video and poster
 * (lib/templates/cloud/publish-request-media.ts) and records the request here
 * (`recordPublishRequest`); nothing leaves the machine. The Templates page
 * lists the requests as review panels — showing exactly those two files — and
 * the user either publishes one (the confirm route,
 * lib/templates/cloud/publish-confirm.ts, which starts the `template_publish`
 * job in-process) or discards it.
 *
 * A request is bound to what the review showed: `fingerprint` is the
 * `contentFingerprint` of the template's text, settings and files plus the
 * sha256 of the request's example and poster. The review read recomputes it
 * (`changed` when it no longer matches), confirm refuses on a mismatch, and
 * the job refuses too — and publishes those very bytes.
 *
 * `confirmCode` is the single-use proof a confirm came from the review panel:
 * rotated on every claim, returned only by the page's read route to a
 * same-origin browser request (`toView(..., { withConfirmCode })`), never by a
 * tool, a tool result or a log line. It is not authentication — see the
 * LIMITATIONS in lib/approval/extensions.ts.
 *
 * Rows carry the catalog they were prepared against (`source`): test mode and
 * a normal boot share LIBI_HOME, and a request prepared against the fixture is
 * neither listed nor confirmable against another catalog.
 *
 * No `lib/jobs` import: the MCP child runs the preflight through this module.
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import path from "node:path";
import { and, eq, inArray } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { files as filesTable, jobs, pieces, templatePublishRequests } from "@/lib/db/schema/sqlite";
import type { TemplatePublishRequestRow } from "@/lib/db/schema/types";
import { getOrCreateTemplatesAuthor, getTemplatesAuthorForDisplay } from "@/lib/db/settings";
import { serverLogger as logger } from "@/lib/logger";
import { describeCatalogSource } from "@/lib/templates/cloud/catalog-origin";
import { catalogSource } from "@/lib/templates/cloud/catalog-source";
import { NICKNAME_PATTERN } from "@/lib/templates/cloud/constants";
import {
  CHANGED_SINCE_REVIEW,
  checkExampleSource,
  contentFingerprint,
  earlyPreflightReasons,
  readPublishContent,
  type ExampleVideoSource,
  type PublishContent,
} from "@/lib/templates/cloud/publish-content";
import {
  EXAMPLE_FILE,
  POSTER_FILE,
  mediaDigest,
  preparingDir,
  promotePreparedMedia,
  readRequestMedia,
  readRequestMediaIn,
  removePublishRequestMedia,
  requestMediaUrl,
  sweepPublishRequestMedia,
  type RequestMedia,
} from "@/lib/templates/cloud/publish-request-media";
import { getPublishPending, publishingTemplateIds } from "@/lib/templates/store";
import type { PublishRequestExample, PublishRequestView } from "@/lib/templates/types";

const TAG = "templates-cloud";

/** What the tool tells the agent (and through it, the user) once a request is recorded. */
export const AWAITING_MESSAGE = "Ready for you to publish. Open Templates in libi and click Publish — I can't publish it for you.";

export const PUBLISHING_NOW = "This template is publishing right now. Wait for that publish to finish.";

function newConfirmCode(): string {
  return randomBytes(24).toString("base64url");
}

function parseExample(json: string): ExampleVideoSource {
  return JSON.parse(json) as ExampleVideoSource;
}

function fileLookup(fileId: string) {
  return getDb().select({ contentType: filesTable.contentType, filename: filesTable.filename, pieceId: filesTable.pieceId }).from(filesTable).where(eq(filesTable.id, fileId)).get() ?? null;
}

function pieceLookup(pieceId: string) {
  return getDb().select({ name: pieces.name }).from(pieces).where(eq(pieces.id, pieceId)).get() ?? null;
}

export type CreateRequestResult =
  /** `nickname`: the public nickname the publish goes out under — the one passed, else the stored (default or chosen) one. */
  | { ok: true; request: { id: string; templateId: string; name: string; nickname: string | null } }
  | { ok: false; error: string };

export interface PublishRequestInput {
  templateId: string;
  exampleVideo: ExampleVideoSource;
  nickname?: string;
}

/**
 * Every local check a publish makes before its first network call — the
 * template's content against the catalog's rules, its earlier publish record,
 * the nickname's shape, and that the example source exists. No nickname is
 * needed: every creator has a default one (lib/templates/cloud/default-nickname.ts),
 * and `nickname` only renames it. The tool runs it before
 * starting the prepare job (a quick, plain refusal), and the job again before
 * it makes any media. Starts nothing and writes nothing.
 */
export async function checkPublishRequestable(input: PublishRequestInput): Promise<{ ok: true; content: PublishContent } | { ok: false; error: string }> {
  const { templateId, exampleVideo } = input;
  let content: PublishContent;
  try {
    content = await readPublishContent(templateId);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  let pending;
  try {
    pending = getPublishPending(templateId);
  } catch {
    return { ok: false, error: 'This template\'s earlier publish record can\'t be read. The user can discard it on the Templates page ("Publishing as"); then prepare the publish again.' };
  }
  if (pending?.needsAttention) {
    return {
      ok: false,
      error: `This template's earlier publish needs attention: ${pending.needsAttention}. The user can discard it on the Templates page ("Publishing as"); then prepare the publish again.`,
    };
  }
  const reasons = earlyPreflightReasons(content, content.row.cloudId);
  if (reasons) return { ok: false, error: `This template can't be published yet:\n- ${reasons.join("\n- ")}` };

  const nickname = input.nickname?.trim();
  if (nickname !== undefined && !NICKNAME_PATTERN.test(nickname)) return { ok: false, error: "nickname: 2–32 letters, digits, spaces, - or _" };

  const example = await checkExampleSource(exampleVideo, { file: fileLookup, piece: pieceLookup });
  if (!example.ok) return { ok: false, error: example.error };
  if (publishingTemplateIds().has(templateId)) return { ok: false, error: PUBLISHING_NOW };
  return { ok: true, content };
}

/**
 * The prepare job's last step: the example and poster it made under
 * `preparingDir(id)` become request `id`'s own, and the request is recorded —
 * one per template, replacing an earlier one that is still awaiting the user
 * (the newer preparation is what they will see; its folder goes too). The
 * fingerprint binds the template as it is now and those two files' bytes.
 * Nothing leaves the machine and no publish starts.
 */
export async function recordPublishRequest(input: PublishRequestInput & { id: string }): Promise<CreateRequestResult> {
  const { id, templateId, exampleVideo } = input;
  let content: PublishContent;
  try {
    content = await readPublishContent(templateId);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  const media = await readRequestMediaIn(preparingDir(id));
  if (!media) return { ok: false, error: "The example video or its poster couldn't be made. Prepare the publish again." };
  const fingerprint = contentFingerprint(content, mediaDigest(media));
  const nickname = input.nickname?.trim() || null;
  // The first publish request makes the creator identity, and with it the
  // default nickname the review shows. Local only; a failure here leaves the
  // publish job to make it (and the review without a nickname line meanwhile).
  let stored: string | null = null;
  try {
    stored = getOrCreateTemplatesAuthor().nickname;
  } catch (err) {
    logger.warn({ tag: TAG, op: "publish_request_author_unavailable", error: err instanceof Error ? err.name : "unknown" }, "could not make the creator identity for a publish request");
  }
  const now = new Date();
  // Synchronous from here to the insert: no sweep sees the folder without its row.
  promotePreparedMedia(id);
  const outcome = getDb().transaction(
    (tx) => {
      if (publishingTemplateIds(tx).has(templateId)) return { kind: "publishing" as const };
      const existing = tx.select().from(templatePublishRequests).where(eq(templatePublishRequests.templateId, templateId)).get();
      if (existing?.status === "publishing") return { kind: "publishing" as const };
      if (existing) tx.delete(templatePublishRequests).where(eq(templatePublishRequests.id, existing.id)).run();
      tx.insert(templatePublishRequests)
        .values({
          id,
          templateId,
          source: catalogSource(),
          exampleVideo: JSON.stringify(exampleVideo),
          nickname,
          fingerprint,
          confirmCode: newConfirmCode(),
          status: "awaiting",
          createdAt: now,
          updatedAt: now,
        })
        .run();
      return existing ? { kind: "replaced" as const, replacedId: existing.id } : { kind: "created" as const };
    },
    { behavior: "immediate" },
  );
  if (outcome.kind === "publishing") {
    removePublishRequestMedia(id);
    return { ok: false, error: PUBLISHING_NOW };
  }
  if (outcome.kind === "replaced") removePublishRequestMedia(outcome.replacedId);
  logger.info(
    { tag: TAG, op: "publish_request_created", templateId, requestId: id, replaced: outcome.kind === "replaced", exampleBytes: media.example.byteLength, posterBytes: media.poster.byteLength },
    "publish request recorded for the user to review",
  );
  return { ok: true, request: { id, templateId, name: content.meta.name, nickname: nickname ?? stored } };
}

/**
 * The fingerprint request `row` would have now: its template's content and its
 * folder's example and poster, read once — the same buffers a publish sends.
 * Throws, in libi's words, when either is gone.
 */
export async function currentRequestState(row: Pick<TemplatePublishRequestRow, "id" | "templateId">): Promise<{ content: PublishContent; media: RequestMedia; fingerprint: string }> {
  const content = await readPublishContent(row.templateId);
  const media = await readRequestMedia(row.id);
  if (!media) throw new Error("The example video prepared for this publish is gone — ask the agent to prepare it again.");
  return { content, media, fingerprint: contentFingerprint(content, mediaDigest(media)) };
}

/**
 * Remove every request folder no request row owns — whichever catalog it was
 * prepared against — and preparations left over from a run that died.
 */
export function sweepStalePublishRequestMedia(): void {
  const live = new Set(getDb().select({ id: templatePublishRequests.id }).from(templatePublishRequests).all().map((r) => r.id));
  const removed = sweepPublishRequestMedia(live);
  if (removed > 0) logger.info({ tag: TAG, op: "publish_request_media_swept", removed }, "removed publish-request media no request owns");
}

/** This catalog's requests, oldest first. */
export function listPublishRequestRows(): TemplatePublishRequestRow[] {
  return getDb()
    .select()
    .from(templatePublishRequests)
    .where(eq(templatePublishRequests.source, catalogSource()))
    .orderBy(templatePublishRequests.createdAt)
    .all();
}

/**
 * The catalog a request was prepared for, whatever this process reads now —
 * the publish job pins it (lib/jobs/runners/template-publish.ts), so a
 * switch made while it runs never sends the rest of it elsewhere. Null when
 * there is no such request.
 */
export function publishRequestSource(id: string): string | null {
  return getDb().select({ source: templatePublishRequests.source }).from(templatePublishRequests).where(eq(templatePublishRequests.id, id)).get()?.source ?? null;
}

/** One of this catalog's requests, or null. */
export function getPublishRequest(id: string): TemplatePublishRequestRow | null {
  const row = getDb().select().from(templatePublishRequests).where(eq(templatePublishRequests.id, id)).get();
  return row && row.source === catalogSource() ? row : null;
}

/** Constant-time: does `sent` match the request's current confirm code? */
export function confirmCodeMatches(row: TemplatePublishRequestRow, sent: unknown): boolean {
  if (typeof sent !== "string" || sent.length === 0) return false;
  const a = Buffer.from(sent);
  const b = Buffer.from(row.confirmCode);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Claim a request for ONE publish: `awaiting` or `failed` → `publishing`, only
 * while its code is still `confirmCode`, and the code rotates in the same
 * statement — so a second confirm with the same code, however fast, finds
 * nothing to claim.
 */
export function claimPublishRequest(id: string, confirmCode: string): boolean {
  const res = getDb()
    .update(templatePublishRequests)
    .set({ status: "publishing", confirmCode: newConfirmCode(), jobId: null, error: null, updatedAt: new Date() })
    .where(and(eq(templatePublishRequests.id, id), eq(templatePublishRequests.confirmCode, confirmCode), inArray(templatePublishRequests.status, ["awaiting", "failed"])))
    .run();
  return res.changes === 1;
}

export function attachPublishJob(id: string, jobId: string): void {
  getDb().update(templatePublishRequests).set({ jobId, updatedAt: new Date() }).where(eq(templatePublishRequests.id, id)).run();
}

/** The publish did not happen: back to the user, with libi's reason (a fresh confirm tries again). */
export function failPublishRequest(id: string, error: string): void {
  getDb()
    .update(templatePublishRequests)
    .set({ status: "failed", error: error.slice(0, 2000), updatedAt: new Date() })
    .where(and(eq(templatePublishRequests.id, id), eq(templatePublishRequests.status, "publishing")))
    .run();
}

/**
 * Bring a `publishing` request in line with its job: gone once the job
 * published (the template's row now carries it), `failed` once the job failed
 * or was cancelled — or never got a job, or its job row is gone (a restart
 * mid-publish marks the job failed). Returns whether anything changed.
 */
export function settlePublishRequest(id: string): boolean {
  const row = getDb().select().from(templatePublishRequests).where(eq(templatePublishRequests.id, id)).get();
  if (!row || row.status !== "publishing") return false;
  // A claim is followed by its job id within the same request; a row caught between the two is left alone for a minute.
  if (!row.jobId) {
    if (Date.now() - row.updatedAt.getTime() < 60_000) return false;
    failPublishRequest(id, "The publish didn't start. Try again.");
    return true;
  }
  const job = getDb().select({ status: jobs.status, error: jobs.error }).from(jobs).where(eq(jobs.id, row.jobId)).get();
  if (job && (job.status === "queued" || job.status === "running" || job.status === "cancel-requested")) return false;
  if (job?.status === "completed") {
    getDb().delete(templatePublishRequests).where(and(eq(templatePublishRequests.id, id), eq(templatePublishRequests.status, "publishing"))).run();
    // Published: the template now holds its own copy of the example and poster.
    removePublishRequestMedia(id);
    logger.info({ tag: TAG, op: "publish_request_done", templateId: row.templateId, requestId: id }, "confirmed publish finished");
    return true;
  }
  const error = !job ? "The publish stopped before it finished. Try again." : job.status === "cancelled" ? "The publish was stopped." : job.error || "The publish failed.";
  failPublishRequest(id, error);
  logger.info({ tag: TAG, op: "publish_request_failed", templateId: row.templateId, requestId: id, jobStatus: job?.status ?? "missing" }, "confirmed publish did not publish");
  return true;
}

/** Discard: gone unless it is publishing right now. */
export function discardPublishRequest(id: string): "discarded" | "not_found" | "publishing" {
  const row = getPublishRequest(id);
  if (!row) return "not_found";
  if (row.status === "publishing") return "publishing";
  const res = getDb()
    .delete(templatePublishRequests)
    .where(and(eq(templatePublishRequests.id, id), inArray(templatePublishRequests.status, ["awaiting", "failed"])))
    .run();
  if (res.changes !== 1) return "publishing";
  removePublishRequestMedia(id);
  logger.info({ tag: TAG, op: "publish_request_discarded", templateId: row.templateId, requestId: id }, "publish request discarded by the user");
  return "discarded";
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** Bytes as the review says them. */
function sizeOf(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/** Exactly what a publish of `content` makes public, one line each. */
function publicItemsOf(content: PublishContent, example: PublishRequestExample, media: RequestMedia | null, nickname: string | null): PublishRequestView["publicItems"] {
  const items: PublishRequestView["publicItems"] = [];
  const tags = content.meta.tags;
  items.push({ label: "Name, description and tags", detail: tags.length ? `Tags: ${tags.join(", ")}` : null });
  items.push({ label: "The instructions for the agent (index.md)", detail: `${content.meta.instructions.trim().split(/\s+/).filter(Boolean).length} words` });
  if (content.parsed.ok) {
    const s = content.parsed.scaffold;
    const layers = [plural(s.overlays.length, "layer"), plural(s.audioClips.length, "audio clip"), plural(s.slots.length, "slot")].join(", ");
    items.push({ label: "The settings: layers, timing, positions, text and styles", detail: layers });
    const hosted = s.assets.filter((a) => typeof a.url === "string");
    if (hosted.length > 0) {
      const hosts = [...new Set(hosted.map((a) => { try { return new URL(a.url!).hostname; } catch { return a.url!; } }))];
      items.push({ label: "Links to hosted media", detail: `${plural(hosted.length, "link")} (${hosts.join(", ")})` });
    }
  } else {
    items.push({ label: "The settings: layers, timing, positions, text and styles", detail: null });
  }
  const assetFiles = content.baseFiles.map((f) => f.name).filter((n) => n.startsWith("assets/"));
  const images = assetFiles.filter((n) => /\.(jpe?g|png|webp|svg)$/i.test(n)).map((n) => n.slice("assets/".length));
  const fonts = assetFiles.filter((n) => /\.(ttf|otf|woff2)$/i.test(n)).map((n) => n.slice("assets/".length));
  if (images.length) items.push({ label: `Included images (${images.length})`, detail: images.join(", ") });
  if (fonts.length) items.push({ label: `Included fonts (${fonts.length})`, detail: fonts.join(", ") });
  const from =
    example.kind === "file"
      ? `made from ${example.filename}`
      : example.kind === "path"
        ? `made from ${example.fileName} on this computer`
        : `exported from the piece${example.pieceName ? ` "${example.pieceName}"` : ""}`;
  const sizes = media ? `, ${sizeOf(media.example.byteLength)} and ${sizeOf(media.poster.byteLength)}` : "";
  items.push({ label: "The example video and poster frame shown here", detail: `Exactly these files${sizes}, ${from}` });
  items.push({ label: "Your public nickname", detail: nickname ?? null });
  return items;
}

function exampleView(exampleVideo: ExampleVideoSource): PublishRequestExample {
  if ("fileId" in exampleVideo) {
    const f = fileLookup(exampleVideo.fileId);
    return { kind: "file", fileId: exampleVideo.fileId, filename: f?.filename ?? exampleVideo.fileId, pieceName: f?.pieceId ? (pieceLookup(f.pieceId)?.name ?? null) : null };
  }
  if ("path" in exampleVideo) return { kind: "path", fileName: path.basename(exampleVideo.path), path: exampleVideo.path };
  return { kind: "export", pieceId: exampleVideo.exportPieceId, pieceName: pieceLookup(exampleVideo.exportPieceId)?.name ?? null };
}

/**
 * The review panel's view of `row`, read from the template and the request's
 * own example and poster as they are now. `withConfirmCode` only for the
 * page's own same-origin read.
 */
export async function toView(row: TemplatePublishRequestRow, opts: { withConfirmCode: boolean }): Promise<PublishRequestView> {
  const exampleVideo = parseExample(row.exampleVideo);
  const example = exampleView(exampleVideo);
  const current = getTemplatesAuthorForDisplay()?.nickname ?? null;
  const nickname = { value: row.nickname ?? current, isNew: row.nickname !== null && row.nickname !== current, replaces: row.nickname !== null && current !== row.nickname ? current : null };
  let content: PublishContent | null = null;
  let stale: string | null = null;
  const media = await readRequestMedia(row.id);
  try {
    content = await readPublishContent(row.templateId);
    if (!media) stale = "The example video prepared for this publish is gone — ask the agent to prepare it again.";
    else if (contentFingerprint(content, mediaDigest(media)) !== row.fingerprint) stale = CHANGED_SINCE_REVIEW;
  } catch (err) {
    stale = err instanceof Error ? err.message : String(err);
  }
  // A running publish is shown as running whatever the template does meanwhile: the job itself refuses a changed template.
  const state = row.status === "publishing" ? "publishing" : stale ? "changed" : row.status;
  return {
    id: row.id,
    templateId: row.templateId,
    state,
    name: content?.meta.name ?? "",
    description: content?.meta.description ?? "",
    tags: content?.meta.tags ?? [],
    example,
    media: media
      ? { videoUrl: requestMediaUrl(row.id, EXAMPLE_FILE), posterUrl: requestMediaUrl(row.id, POSTER_FILE), exampleBytes: media.example.byteLength, posterBytes: media.poster.byteLength }
      : null,
    nickname,
    publicItems: content ? publicItemsOf(content, example, media, nickname.value) : [],
    republish: !!content?.row.cloudId,
    catalog: describeCatalogSource(row.source),
    error: state === "changed" ? stale : row.error,
    ...(opts.withConfirmCode && (state === "awaiting" || state === "failed") ? { confirmCode: row.confirmCode } : {}),
    createdAt: row.createdAt.getTime(),
  };
}
