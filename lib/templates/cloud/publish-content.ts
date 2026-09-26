/**
 * What a publish of a local template would send, read from the template as it
 * is NOW — the part of a publish that needs no media and no network.
 *
 * Two callers read it the same way, so they cannot disagree about what the
 * user reviewed:
 *   - `libi.publish_template` (mcp/tools/template-cloud-tools.ts) and its
 *     `template_publish_prepare` job, which run the preflight below, make the
 *     request's own example and poster, and record a publish REQUEST bound to
 *     `contentFingerprint` (lib/templates/cloud/publish-requests.ts);
 *   - the `template_publish` job (lib/jobs/runners/template-publish.ts), which
 *     refuses to publish when the fingerprint it computes is not the one the
 *     user reviewed.
 *
 * No `lib/jobs` import here: the MCP child reads this module.
 */
import { createHash } from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import { CAPS, EXAMPLE_MAX_LONG_EDGE } from "@/lib/templates/cloud/constants";
import { isProductionLink, otherCatalogOf } from "@/lib/templates/cloud/catalog-source";
import {
  manifestEntryFor,
  manifestFor,
  preflightPublish,
  publishRequestBytes,
  type ExampleMeta,
  type ManifestEntry,
  type PreflightFile,
} from "@/lib/templates/cloud/preflight";
import { validateScaffold, type TemplateScaffold } from "@/lib/templates/scaffold";
import { EXAMPLE_FILE, POSTER_FILE, type RequestMediaDigest } from "@/lib/templates/cloud/publish-request-media";
import { getTemplate, getTemplateRecord, otherCatalogPublishRefusal, readInstructions, readScaffold, templateDir } from "@/lib/templates/store";
import type { TemplateRow } from "@/lib/db/schema/types";

export const SCAFFOLD_FILE = "template.json";
export const INSTRUCTIONS_FILE = "index.md";
export { EXAMPLE_FILE, POSTER_FILE };
const CODE_FILE = /^overlays\/.+\.jsx$/;

/**
 * Said when the template (its text, settings, files, or the example video and
 * poster prepared for it) is not what the user reviewed: by the review, by the
 * confirm route before it starts a publish, and by the job itself should it
 * change in between.
 */
export const CHANGED_SINCE_REVIEW = "This template changed since it was prepared — ask the agent to prepare it again.";

/** Where the catalog's example comes from — one of the three, exactly. */
export type ExampleVideoSource = { fileId: string } | { path: string } | { exportPieceId: string };

/** The text a publish sends, as the listing shows it and the site checks it. */
export interface PublishMeta {
  name: string;
  description: string;
  tags: string[];
  scaffold: TemplateScaffold | Record<string, unknown>;
  instructions: string;
}

export interface PublishContent {
  row: TemplateRow;
  dir: string;
  meta: PublishMeta;
  /** The scaffold schema-parsed, or why it isn't valid (the preflight reports it). */
  parsed: ReturnType<typeof validateScaffold>;
  scaffoldBytes: Buffer;
  instructionsBytes: Buffer;
  /** template.json and index.md from memory, then every other file on disk — never the media. */
  baseFiles: PreflightFile[];
}

/** index.md as the catalog stores it: no BOM, LF line ends only. */
function lfOnly(text: string): string {
  return text.replace(/^\ufeff/, "").replace(/\r\n?/g, "\n");
}

/**
 * Read `templateId` as a publish would send it. Throws, in the words the agent
 * and the user see, when it can't be published from here at all: not found, an
 * installed template, one linked to the production catalog while this libi
 * reads another, or a scaffold that can't be read.
 */
export async function readPublishContent(templateId: string): Promise<PublishContent> {
  // As THIS catalog sees it: a link to another catalog (test mode and a normal
  // boot share LIBI_HOME) reads as none, so this publishes afresh here rather
  // than republish, or replay, an id this catalog never issued — but never
  // over a link to the production catalog.
  const row = getTemplate(templateId);
  if (!row) throw new Error(`template not found: ${templateId}`);
  if (row.origin !== "local") {
    throw new Error("Only a template made in this libi can be published — this one was installed from the catalog.");
  }
  const otherCatalog = otherCatalogOf(getTemplateRecord(templateId) ?? row);
  if (otherCatalog !== null && isProductionLink(otherCatalog)) throw new Error(otherCatalogPublishRefusal());
  const dir = templateDir(templateId);
  const read = await readScaffold(templateId);
  if (!read.ok) throw new Error(`This template can't be read: ${read.reason}`);

  const name = row.name.trim();
  const description = row.description.trim();
  const tags = JSON.parse(row.tags) as string[];
  // The row's metadata goes into the scaffold that is sent AND uploaded; the
  // re-parse drops any key the schema would strip, so the bytes are its output.
  const withMeta = { ...read.scaffold, name, description, tags };
  const parsed = validateScaffold(withMeta);
  const scaffold = parsed.ok ? parsed.scaffold : withMeta;
  const instructions = lfOnly(await readInstructions(templateId));
  const scaffoldBytes = Buffer.from(JSON.stringify(scaffold), "utf8");
  const instructionsBytes = Buffer.from(instructions, "utf8");

  // The four fixed files are the job's own: template.json and index.md from memory, the media made later.
  const onDisk = await manifestFor(dir, { skip: [SCAFFOLD_FILE, INSTRUCTIONS_FILE, EXAMPLE_FILE, POSTER_FILE] });
  const baseFiles: PreflightFile[] = [
    { ...manifestEntryFor(SCAFFOLD_FILE, scaffoldBytes), content: scaffoldBytes },
    { ...manifestEntryFor(INSTRUCTIONS_FILE, instructionsBytes), content: instructionsBytes },
  ];
  for (const e of onDisk) {
    // Code files are sniffed the way commit will; a huge one is refused on size alone.
    const sniff = CODE_FILE.test(e.name) && e.bytes <= 1024 * 1024;
    baseFiles.push(sniff ? { ...e, content: await fsp.readFile(path.join(dir, e.name)) } : e);
  }
  return { row, dir, meta: { name, description, tags, scaffold, instructions }, parsed, scaffoldBytes, instructionsBytes, baseFiles };
}

export function manifestOf(files: readonly PreflightFile[]): ManifestEntry[] {
  return files.map((f) => ({ name: f.name, bytes: f.bytes, contentType: f.contentType!, md5: f.md5! }));
}

/**
 * Everything a publish commits: the template's text and files, and the sha256
 * of the example video and poster the request prepared
 * (lib/templates/cloud/publish-request-media.ts). The user's review is bound
 * to it, and the job keeps it on a pending publish (a retry of changed content
 * is a new publish).
 */
export function contentFingerprint(content: Pick<PublishContent, "meta" | "baseFiles">, media: RequestMediaDigest): string {
  return createHash("sha256")
    .update(JSON.stringify({ meta: content.meta, files: manifestOf(content.baseFiles), example: { sha256: media.example }, poster: { sha256: media.poster } }))
    .digest("hex");
}

/** Every cloud id is 20 characters; a stand-in of that length measures the same. */
const ID_STANDIN = "a".repeat(20);
/** The widest version the client accepts back (1,000,000): the widest a commit body can carry. */
export const VERSION_STANDIN = 1_000_000;

/**
 * Commit's request — the body plus templateId and version, the larger of the
 * two the site reads — measured as the client will send it.
 */
export function commitRequestBytes(body: Record<string, unknown>, cloudId: string | null, version: number): number {
  return publishRequestBytes({ ...body, templateId: cloudId ?? ID_STANDIN, version });
}

/**
 * Before the media exists: the same request with the example and poster at
 * their widest — the largest byte count and duration each could print as —
 * so it can only over-count, by a few dozen bytes at most.
 */
function mediaStandIns(): { files: ManifestEntry[]; example: ExampleMeta } {
  const md5 = "A".repeat(22) + "==";
  return {
    files: [
      { name: EXAMPLE_FILE, bytes: CAPS.example, contentType: "video/mp4", md5 },
      { name: POSTER_FILE, bytes: CAPS.poster, contentType: "image/jpeg", md5 },
    ],
    // 19 characters, the longest a duration in [0.1, 15] prints as.
    example: { durationSec: 0.12345678901234566, width: EXAMPLE_MAX_LONG_EDGE, height: EXAMPLE_MAX_LONG_EDGE },
  };
}

/** The publish body: the row's text, the manifest and the example, under `cloudId` when there is one. */
export function publishBodyOf(meta: PublishMeta, cloudId: string | null, files: ManifestEntry[], example: ExampleMeta): Record<string, unknown> {
  return { ...(cloudId ? { templateId: cloudId } : {}), ...meta, files, example };
}

/**
 * Every catalog rule that needs no media, with the media at their widest:
 * the reasons, or null when nothing is refused yet. The site stays the
 * authority, and the job runs the complete preflight once the media exist.
 */
export function earlyPreflightReasons(content: PublishContent, cloudId: string | null): string[] | null {
  const standIns = mediaStandIns();
  const body = publishBodyOf(content.meta, cloudId, [...manifestOf(content.baseFiles), ...standIns.files], standIns.example);
  const early = preflightPublish({ ...content.meta, files: content.baseFiles, example: null, mediaPending: true, bodyBytes: commitRequestBytes(body, cloudId, VERSION_STANDIN) });
  return early.ok ? null : early.reasons;
}

/** The error a refused preflight gives, every reason listed. */
export function preflightRefusal(reasons: string[]): Error {
  return new Error(`This template can't be published yet:\n- ${reasons.join("\n- ")}`);
}

/** What `exampleVideo` names, as the review shows it — or why it names nothing usable. */
export async function checkExampleSource(
  exampleVideo: ExampleVideoSource,
  lookups: { file: (fileId: string) => { contentType: string | null } | null; piece: (pieceId: string) => { name: string } | null },
): Promise<{ ok: true } | { ok: false; error: string }> {
  if ("path" in exampleVideo) {
    const st = await fsp.stat(exampleVideo.path).catch(() => null);
    if (!path.isAbsolute(exampleVideo.path) || !st?.isFile()) return { ok: false, error: `example video not found: ${exampleVideo.path}` };
    return { ok: true };
  }
  if ("fileId" in exampleVideo) {
    const f = lookups.file(exampleVideo.fileId);
    if (!f) return { ok: false, error: `file not found: ${exampleVideo.fileId}` };
    if (f.contentType && !f.contentType.startsWith("video/")) return { ok: false, error: `the example must be a video; ${exampleVideo.fileId} is ${f.contentType}` };
    return { ok: true };
  }
  if (!lookups.piece(exampleVideo.exportPieceId)) return { ok: false, error: `piece not found: ${exampleVideo.exportPieceId}` };
  return { ok: true };
}
