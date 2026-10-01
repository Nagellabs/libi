/**
 * Templates: the `templates` table + the folder under `<LIBI_HOME>/templates/<id>/`.
 * The ONLY writer of that folder (spec §3.4). Every scaffold read goes
 * through `validateScaffold` (spec §3.5, §9), so a folder a user hand-edited
 * is reported broken rather than applied.
 */
import crypto from "node:crypto";
import { constants as fsConstants, createWriteStream, type Stats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { and, desc, eq, gte, inArray, isNotNull, sql } from "drizzle-orm";
import { z } from "zod/v3";
import { getDb } from "@/lib/db/client";
import { jobs, pieces, templatePublishRequests, templates, templateUses } from "@/lib/db/schema/sqlite";
import type { TemplateRow } from "@/lib/db/schema/types";
import { getLibiHome } from "@/lib/libi-home";
import { assertSafePieceId } from "@/lib/security/pieceId";
import { serverLogger as logger } from "@/lib/logger";
import {
  validateScaffold,
  normalizeTags,
  tagsError,
  TEMPLATE_LIMITS,
  type TemplateScaffold,
} from "@/lib/templates/scaffold";
import type { TemplateOrder, TemplateScope, TemplateSummary } from "@/lib/templates/types";
import { buildMatchExpression, ftsSearch, tokenize } from "@/lib/templates/search";
import { catalogSummaries, compareSummaries, ensureCatalogForRead } from "@/lib/templates/cloud/catalog-cache";
import { TEST_MODE_SOURCE, catalogSource, describeCatalog, isProductionLink, otherCatalogOf, recordedSource, whereProductionIsUsed } from "@/lib/templates/cloud/catalog-source";
import { PRODUCTION_SITE_URL } from "@/lib/site-url";
import { removePublishRequestMedia } from "@/lib/templates/cloud/publish-request-media";

export const TEMPLATES_LOG_TAG = "templates";
const SCAFFOLD_FILE = "template.json";
const INSTRUCTIONS_FILE = "index.md";
const POSTER_FILE = "poster.jpg";
const EXAMPLE_FILE = "example.mp4";
const SEVEN_DAYS_S = 7 * 86_400;
/** An FTS page big enough that the chosen order, not `rank`, decides the page. */
const FTS_CANDIDATES = 500;

export interface TemplatePaths {
  dir: string;
  scaffoldPath: string;
  instructionsPath: string;
  codeFiles: string[];
}

export interface CreateTemplateInput {
  id?: string;
  name: string;
  description: string;
  tags: string[];
  origin?: "local" | "installed";
  cloudId?: string | null;
  version?: number;
  createdFromPieceId?: string | null;
  /** `assets[].sha256`/`bytes` are filled in from the copies. */
  scaffold: TemplateScaffold;
  /** `index.md` body. */
  instructions: string;
  /** media/fonts/poster/example: `rel` under the dir, `from` = absolute source. */
  copies: Array<{ rel: string; from: string }>;
  /** Code bodies, written verbatim. */
  writes: Array<{ rel: string; body: string }>;
}

export interface UpdateTemplatePatch {
  name?: string;
  description?: string;
  tags?: string[];
  replace?: {
    scaffold: TemplateScaffold;
    copies: CreateTemplateInput["copies"];
    writes: CreateTemplateInput["writes"];
  };
}

/**
 * A publish the catalog has prepared and libi has not yet seen land — kept on
 * the row (`templates.publish_pending`) from the moment prepare answers until
 * commit succeeds, so that a timeout, a crash or a restart never leaves libi
 * not knowing the cloud id it was given. A retry finishes THIS publish (the
 * same uploads while they last, the same commit body, which the site answers
 * idempotently). Once this publish can provably never go live it is marked
 * `abandoned`, not forgotten: the site reserves a first publish's id for its
 * author, so the next prepare asks for the SAME id and a second public
 * template cannot happen whatever the site's lists say.
 */
export interface PublishPending {
  cloudId: string;
  version: number;
  /** ms since the epoch: the signed upload URLs stop working then. */
  expiresAt: number;
  /** The exact commit body (prepare's body plus templateId and version): a replayed commit must repeat it. */
  body: Record<string, unknown>;
  /** The signed PUTs prepare returned — write-only capabilities for `tmp/<id>/v<n>/`, dead after `expiresAt`. */
  uploads: Array<{ name: string; url: string; headers: Record<string, string> }>;
  /** Names already uploaded. */
  uploaded: string[];
  /** What the body was built from (metadata, scaffold, instructions, files, example source): unchanged → resumable. */
  fingerprint: string;
  /**
   * The authorId of the creator key this publish was prepared under — set
   * when prepare answers, never changed after (a replay under a key imported
   * since keeps it). Only that key's list can say whether the publish went
   * live, so a discard that must ask the list refuses when it names another
   * key. Optional to read: a record written before it existed names none, and
   * is treated as another key's.
   */
  authorId?: string;
  /**
   * ms since the epoch: when the latest commit that got no answer was sent —
   * written BEFORE each send, so a crash mid-commit counts. While it is recent
   * that commit may still be running on the site, and a "nothing pending"
   * proves nothing.
   */
  unansweredCommitAt?: number;
  /**
   * Why libi stopped retrying this publish (the site answered it with another
   * id or version). Set, the publish is never resent: the creator discards it.
   */
  needsAttention?: string;
  /**
   * This publish can never go live (no commit of it was ever sent, or the
   * site refused it definitively and it did not land). Kept only for its id:
   * the next prepare asks for it again — the site answers a first publish's
   * reserved id, or a live template's, with fresh URLs — and replaces this
   * record. Never uploaded to or committed again.
   */
  abandoned?: true;
}

const publishPendingSchema = z.object({
  cloudId: z.string().min(1),
  version: z.number().int().positive(),
  expiresAt: z.number().finite(),
  body: z.record(z.unknown()),
  uploads: z.array(z.object({ name: z.string(), url: z.string(), headers: z.record(z.string()) })),
  uploaded: z.array(z.string()),
  fingerprint: z.string(),
  authorId: z.string().min(1).optional(),
  unansweredCommitAt: z.number().finite().optional(),
  needsAttention: z.string().optional(),
  abandoned: z.literal(true).optional(),
});

/**
 * The template's pending publish, or null. Throws on a record it cannot read:
 * treating it as absent would let a retry mint a second public template.
 */
export function getPublishPending(id: string): PublishPending | null {
  const row = getTemplate(id);
  if (!row?.publishPending) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(row.publishPending);
  } catch {
    raw = null;
  }
  const parsed = publishPendingSchema.safeParse(raw);
  if (!parsed.success) throw new Error("this template's pending publish record is unreadable");
  return parsed.data;
}

/**
 * How long a commit libi got no answer to may still be running on the site:
 * libi-site's COMMIT_LEASE_MS (2 min), well over the commit route's 60 s
 * `maxDuration` — the site's own bound on a commit it has not heard back from.
 */
export const COMMIT_MAY_RUN_MS = 2 * 60_000;

/** An earlier commit of this publish got no answer, recently enough that it may still be running. */
export function unansweredCommitMayRun(pending: PublishPending, now = Date.now()): boolean {
  return pending.unansweredCommitAt !== undefined && now - pending.unansweredCommitAt < COMMIT_MAY_RUN_MS;
}

/** Every upload of this publish is done — so a commit of it may have been sent. Before that, none ever was. */
export function allUploaded(pending: PublishPending): boolean {
  return pending.uploads.every((u) => pending.uploaded.includes(u.name));
}

/**
 * Record (or advance) the pending publish, as THIS catalog's. Leaves
 * `updatedAt` alone: nothing the user sees changed. A throwaway link from
 * another catalog (the test-mode fixture's, a staging site's) is replaced —
 * its cloud id goes with it; a link to the production catalog never is.
 */
export function setPublishPending(id: string, pending: PublishPending): void {
  const row = getTemplateRecord(id);
  const other = row ? otherCatalogOf(row) : null;
  if (other !== null && isProductionLink(other)) throw new Error(otherCatalogPublishRefusal());
  getDb()
    .update(templates)
    .set({ publishPending: JSON.stringify(pending), cloudSource: catalogSource(), ...(other !== null ? { cloudId: null } : {}) })
    .where(eq(templates.id, id))
    .run();
  if (other !== null) {
    logger.info({ tag: TEMPLATES_LOG_TAG, op: "other_catalog_link_replaced", templateId: id, from: other, to: catalogSource() }, "a publish here replaced this template's link to another catalog");
  }
}

/** Why a template published to the production catalog is not published against another one. */
export function otherCatalogPublishRefusal(): string {
  return `This template is published to the public catalog, and this libi is using ${describeCatalog(catalogSource())}: publishing it here would replace its link to the public one. Publish it ${whereProductionIsUsed()}.`;
}

/**
 * Forget the pending publish — only once its id is no use either: the site
 * holds nothing under it (a lapsed reservation), or the creator discards it.
 */
export function clearPublishPending(id: string): void {
  getDb().update(templates).set({ publishPending: null }).where(eq(templates.id, id)).run();
}

/** Every template with a pending publish, oldest first: the Templates page's "Discard the pending publish" list. */
export function listPublishPendingTemplates(): Array<{ id: string; name: string }> {
  return getDb()
    .select({ id: templates.id, name: templates.name })
    .from(templates)
    .where(isNotNull(templates.publishPending))
    .orderBy(templates.createdAt)
    .all();
}

/** Whether a publish is pending — without parsing the record. */
export function hasPublishPending(id: string): boolean {
  return Boolean(getTemplate(id)?.publishPending);
}

/**
 * `<LIBI_HOME>/template-publish/<id>`: where a publish makes its example and
 * poster. It outlives a failed attempt while a publish is pending, so a retry
 * can upload the very bytes prepare signed for.
 */
export function publishWorkDir(id: string): string {
  assertSafePieceId(id);
  return path.join(getLibiHome(), "template-publish", id);
}

export function templatesRoot(): string {
  return path.join(getLibiHome(), "templates");
}

/** `<LIBI_HOME>/templates/<id>` — the id is guarded like a piece id. */
export function templateDir(id: string): string {
  assertSafePieceId(id);
  return path.join(templatesRoot(), id);
}

export function templatePaths(id: string, scaffold: TemplateScaffold): TemplatePaths {
  const dir = templateDir(id);
  return {
    dir,
    scaffoldPath: path.join(dir, SCAFFOLD_FILE),
    instructionsPath: path.join(dir, INSTRUCTIONS_FILE),
    codeFiles: scaffold.overlays.flatMap((o) => (o.codeFile ? [path.join(dir, o.codeFile)] : [])),
  };
}

/** Lexical + realpath containment of `rel` inside `dir`. Returns the REAL
 *  absolute path, so a symlink (or a symlinked parent folder) pointing out of
 *  the template is refused. */
async function resolveWithin(dir: string, rel: string): Promise<string> {
  const resolved = path.resolve(dir, rel);
  if (resolved !== dir && !resolved.startsWith(dir + path.sep)) throw new Error("template_path_escape");
  const [real, realDir] = await Promise.all([fs.realpath(resolved), fs.realpath(dir)]);
  if (real !== realDir && !real.startsWith(realDir + path.sep)) throw new Error("template_path_escape");
  return real;
}

/** The absolute real path of a file inside a template's folder. Throws
 *  `template_path_escape` for anything that resolves outside it. */
export async function readTemplateFile(id: string, rel: string): Promise<string> {
  return resolveWithin(templateDir(id), rel);
}

function scaffoldHasCode(s: TemplateScaffold): boolean {
  return s.overlays.some((o) => o.codeFile !== undefined);
}

function assertRel(rel: string): void {
  if (rel.length === 0 || rel.startsWith("/") || rel.includes("\\") || rel.split("/").includes("..")) {
    throw new Error(`unsafe template path: ${rel}`);
  }
}

async function writeScaffoldFile(dir: string, scaffold: TemplateScaffold): Promise<void> {
  const json = JSON.stringify(scaffold, null, 2);
  if (Buffer.byteLength(json, "utf8") > TEMPLATE_LIMITS.scaffoldBytes) throw new Error("template.json over 256 KB");
  await fs.writeFile(path.join(dir, SCAFFOLD_FILE), json, "utf8");
}

/** `O_NOFOLLOW` where the platform has it: opening a symlink then fails with
 *  ELOOP instead of reading whatever it points at. Windows has no such flag;
 *  there the `lstat` checks before the open are the guard. */
const OPEN_NO_FOLLOW = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0);

/** Open a file for reading only if it is a REGULAR file (never through a
 *  symlink) of at most `maxBytes`. The size and kind are checked on the open
 *  handle, so a swap after an earlier `lstat` cannot slip another file in. */
async function openRegularFile(abs: string, label: string, maxBytes: number): Promise<fs.FileHandle> {
  let handle: fs.FileHandle;
  try {
    handle = await fs.open(abs, OPEN_NO_FOLLOW);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ELOOP" || code === "EMLINK") throw new Error(`${label} is a symlink`);
    throw new Error(`${label} is not readable (${code ?? "error"})`);
  }
  const st = await handle.stat();
  if (!st.isFile()) {
    await handle.close();
    throw new Error(`${label} is not a regular file`);
  }
  if (st.size > maxBytes) {
    await handle.close();
    throw new Error(`${label} over ${maxBytes} bytes`);
  }
  return handle;
}

/** Stream one regular file into `dest`, hashing as it goes, and stop at
 *  `maxBytes` even if the file grows while it is read. Never buffers the file:
 *  a template's video can be most of a gigabyte. */
async function copyRegularFile(from: string, dest: string, label: string, maxBytes: number): Promise<{ sha256: string; bytes: number }> {
  const handle = await openRegularFile(from, label, maxBytes);
  const hash = crypto.createHash("sha256");
  let bytes = 0;
  const meter = new Transform({
    transform(chunk: Buffer, _enc, done) {
      bytes += chunk.byteLength;
      if (bytes > maxBytes) return done(new Error(`${label} over ${maxBytes} bytes`));
      hash.update(chunk);
      done(null, chunk);
    },
  });
  try {
    await pipeline(handle.createReadStream(), meter, createWriteStream(dest));
  } finally {
    await handle.close().catch(() => {});
  }
  return { sha256: hash.digest("hex"), bytes };
}

/** Copy `copies`, write `writes`, fill asset sha256/bytes, write template.json.
 *  A copy source must be a regular file (never followed through a symlink),
 *  each at most `assetBytes` and all of them together at most `totalBytes`. */
async function writeFolderContents(
  dir: string,
  scaffold: TemplateScaffold,
  copies: CreateTemplateInput["copies"],
  writes: CreateTemplateInput["writes"],
): Promise<TemplateScaffold> {
  const byRel = new Map<string, { sha256: string; bytes: number }>();
  let total = 0;
  for (const c of copies) {
    assertRel(c.rel);
    const dest = path.join(dir, c.rel);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    const copied = await copyRegularFile(c.from, dest, c.rel, TEMPLATE_LIMITS.assetBytes);
    total += copied.bytes;
    if (total > TEMPLATE_LIMITS.totalBytes) throw new Error(`template files over ${TEMPLATE_LIMITS.totalBytes} bytes in total`);
    byRel.set(c.rel, copied);
  }
  for (const w of writes) {
    assertRel(w.rel);
    if (Buffer.byteLength(w.body, "utf8") > TEMPLATE_LIMITS.codeFileBytes) {
      throw new Error(`code file over 128 KB: ${w.rel}`);
    }
    const dest = path.join(dir, w.rel);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.writeFile(dest, w.body, "utf8");
  }
  const withHashes: TemplateScaffold = {
    ...scaffold,
    assets: scaffold.assets.map((a) => (a.file && byRel.has(a.file) ? { ...a, ...byRel.get(a.file)! } : a)),
  };
  const validated = validateScaffold(withHashes);
  if (!validated.ok) throw new Error(`invalid scaffold: ${validated.reason}`);
  await writeScaffoldFile(dir, validated.scaffold);
  return validated.scaffold;
}

/** The files a `replace` swaps out; `index.md`, `poster.jpg` and `example.mp4`
 *  are the template's own and survive. */
const REPLACEABLE = ["overlays", "assets", SCAFFOLD_FILE] as const;

/** Move the staged `REPLACEABLE` entries into the live folder. The old copies
 *  go aside first and are removed only once the new ones are in place, so a
 *  failure part-way through puts the original back rather than leaving a
 *  half-swapped folder.
 *
 *  A rename inside one directory can still fail — EPERM/EBUSY on Windows while a
 *  file under `assets/` is open, ENOSPC on the aside mkdir — so the rollback is
 *  written for a THROW ANYWHERE in either loop: it removes only what this call
 *  actually moved in (never an original the move-aside loop had not reached yet),
 *  and if it cannot put an original back it keeps `aside` and names it in the log
 *  instead of deleting the one remaining copy. */
async function swapReplacement(dir: string, staging: string): Promise<void> {
  const aside = `${dir}.old-${crypto.randomBytes(6).toString("hex")}`;
  await fs.mkdir(aside, { recursive: true });
  const movedAside: string[] = [];
  const movedIn: string[] = [];
  try {
    for (const name of REPLACEABLE) {
      if (await exists(path.join(dir, name))) {
        await fs.rename(path.join(dir, name), path.join(aside, name));
        movedAside.push(name);
      }
    }
    for (const name of REPLACEABLE) {
      if (await exists(path.join(staging, name))) {
        await fs.rename(path.join(staging, name), path.join(dir, name));
        movedIn.push(name);
      }
    }
  } catch (err) {
    for (const name of movedIn) await fs.rm(path.join(dir, name), { recursive: true, force: true });
    const stranded: string[] = [];
    for (const name of movedAside) {
      try {
        await fs.rename(path.join(aside, name), path.join(dir, name));
      } catch {
        stranded.push(name);
      }
    }
    if (stranded.length > 0) {
      logger.error(
        { tag: TEMPLATES_LOG_TAG, op: "update_replace_rollback_incomplete", dir, aside, stranded },
        "template replace rollback incomplete, the originals are kept in the aside folder",
      );
      throw err;
    }
    await fs.rm(aside, { recursive: true, force: true });
    throw err;
  }
  await fs.rm(aside, { recursive: true, force: true });
}

/** The row's own text, held to the store's limits; the tags come back normalized. Throws the reason. */
function checkedMetadata(input: { name: string; description: string; tags: string[]; instructions: string }): string[] {
  const tags = normalizeTags(input.tags);
  const tagProblem = tagsError(tags);
  if (tagProblem) throw new Error(tagProblem);
  if (input.name.trim().length === 0 || input.name.length > TEMPLATE_LIMITS.nameChars) throw new Error("name: 1–80 chars");
  if (input.description.length > TEMPLATE_LIMITS.descriptionChars) throw new Error("description: ≤ 500 chars");
  if (Buffer.byteLength(input.instructions, "utf8") > TEMPLATE_LIMITS.instructionsBytes) throw new Error("index.md over 32 KB");
  return tags;
}

export async function createTemplate(input: CreateTemplateInput): Promise<TemplateRow> {
  const tags = checkedMetadata(input);
  const id = input.id ?? crypto.randomUUID();
  const dir = templateDir(id);
  // A caller-supplied id that is already taken: the insert would fail on the PK
  // anyway, and the cleanup below would then delete a LIVE template's folder.
  if (input.id !== undefined && getTemplate(id)) throw new Error("template_exists");
  const dirExisted = await exists(dir);
  await fs.mkdir(dir, { recursive: true });
  try {
    const scaffold = await writeFolderContents(
      dir,
      { ...input.scaffold, name: input.name, description: input.description, tags },
      input.copies,
      input.writes,
    );
    await fs.writeFile(path.join(dir, INSTRUCTIONS_FILE), input.instructions, "utf8");
    const [row] = getDb()
      .insert(templates)
      .values({
        id,
        name: input.name,
        description: input.description,
        // Always a JSON array string: the FTS triggers run json_each(tags).
        tags: JSON.stringify(tags),
        origin: input.origin ?? "local",
        cloudId: input.cloudId ?? null,
        cloudSource: input.cloudId ? catalogSource() : null,
        version: input.version ?? 1,
        createdFromPieceId: input.createdFromPieceId ?? null,
        hasCode: scaffoldHasCode(scaffold),
      })
      .returning()
      .all();
    logger.info(
      { tag: TEMPLATES_LOG_TAG, op: "create", templateId: id, overlays: scaffold.overlays.length, assets: scaffold.assets.length, hasCode: row.hasCode },
      "template created",
    );
    return row;
  } catch (err) {
    // Only ever remove a folder THIS call created.
    if (!dirExisted) await fs.rm(dir, { recursive: true, force: true });
    const fields = { tag: TEMPLATES_LOG_TAG, templateId: id, folderRemoved: !dirExisted, err: err instanceof Error ? err.message : String(err) };
    // Another install of the same public template inserted its row first: a
    // benign race the installer recovers from by using that row.
    if (isCloudIdTaken(err)) logger.info({ ...fields, op: "create_lost_cloud_id_race" }, "template create lost the race for its catalog id");
    else logger.error({ ...fields, op: "create_failed" }, "template create failed");
    throw err;
  }
}

/** The insert broke the UNIQUE index on `templates.cloud_id`: another row holds this catalog id. */
export function isCloudIdTaken(err: unknown): boolean {
  for (let e: unknown = err; e instanceof Error; e = e.cause) {
    if (/UNIQUE constraint failed: templates\.cloud_id/.test(e.message)) return true;
  }
  return false;
}

/**
 * The row as THIS catalog sees it: a link to another catalog (test mode and a
 * normal boot share LIBI_HOME) is no link here — `cloudId` and
 * `publishPending` read null, so nothing republishes, replays, reinstalls or
 * reports against the wrong catalog. `origin` is kept: an installed
 * template's words are a stranger's whichever catalog they came from.
 */
export function getTemplate(id: string): TemplateRow | null {
  const row = getTemplateRecord(id);
  return row ? seenHere(row) : null;
}

/** The row exactly as stored, links from every catalog included — for code that must tell them apart. */
export function getTemplateRecord(id: string): TemplateRow | null {
  return getDb().select().from(templates).where(eq(templates.id, id)).get() ?? null;
}

function seenHere(row: TemplateRow): TemplateRow {
  return otherCatalogOf(row) === null ? row : { ...row, cloudId: null, publishPending: null };
}

/** SQL: the row's link (if any) is this catalog's — a null source is the production site's. */
export function linkedToThisCatalog() {
  return sql`coalesce(${templates.cloudSource}, ${PRODUCTION_SITE_URL}) = ${catalogSource()}`;
}

export function uses7dByTemplate(): Map<string, number> {
  const since = new Date((Math.floor(Date.now() / 1000) - SEVEN_DAYS_S) * 1000);
  const rows = getDb()
    .select({ templateId: templateUses.templateId, n: sql<number>`count(*)` })
    .from(templateUses)
    .where(gte(templateUses.usedAt, since))
    .groupBy(templateUses.templateId)
    .all();
  return new Map(rows.map((r) => [r.templateId, Number(r.n)]));
}

/**
 * A template's use on this machine, for its page: `total` is the row's
 * counter (every use ever), `d7` / `d30` count its use rows over the last 7
 * and 30 days, `lastUsedAt` is the row's.
 */
export function localUsage(id: string, now: number = Date.now()): { total: number; d7: number; d30: number; lastUsedAt: string | null } {
  const db = getDb();
  const row = db.select({ useCount: templates.useCount, lastUsedAt: templates.lastUsedAt }).from(templates).where(eq(templates.id, id)).get();
  const since = (days: number) => new Date((Math.floor(now / 1000) - days * 86_400) * 1000);
  const count = (days: number) =>
    Number(
      db
        .select({ n: sql<number>`count(*)` })
        .from(templateUses)
        .where(and(eq(templateUses.templateId, id), gte(templateUses.usedAt, since(days))))
        .get()?.n ?? 0,
    );
  return { total: row?.useCount ?? 0, d7: count(7), d30: count(30), lastUsedAt: row?.lastUsedAt ? row.lastUsedAt.toISOString() : null };
}

/**
 * The local row a public catalog entry already has here — its installed copy
 * first, else the author's own published template — from THIS catalog only
 * (`linkedToThisCatalog`): a row linked to another catalog is not a copy of
 * this one's entry. `origin` tells the two apart (`installed`, or `local` —
 * the user published it), so the page can word its link. Null when none.
 */
export function findInstalledTemplate(cloudId: string): { id: string; origin: "local" | "installed" } | null {
  const db = getDb();
  const here = and(eq(templates.cloudId, cloudId), linkedToThisCatalog());
  const installed = db.select({ id: templates.id }).from(templates).where(and(here, eq(templates.origin, "installed"))).orderBy(desc(templates.updatedAt)).limit(1).get();
  if (installed) return { id: installed.id, origin: "installed" };
  const own = db.select({ id: templates.id, origin: templates.origin }).from(templates).where(here).limit(1).get();
  return own ? { id: own.id, origin: own.origin === "installed" ? "installed" : "local" } : null;
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/** The file's mtime in ms, or null when it isn't there. */
async function mtimeMs(p: string): Promise<number | null> {
  try {
    return (await fs.stat(p)).mtimeMs;
  } catch {
    return null;
  }
}

/**
 * Whether a piece exists. A template's `createdFromPieceId` is lineage: its FK
 * says `set null`, and FK actions DO run (lib/db/schema/sqlite.ts, the note on
 * `files.folderId`), so a deleted piece normally leaves it null. Asking the
 * pieces table still answers for any id — a stored one, or one a job captured
 * before the piece was deleted under it.
 */
export function sourcePieceExists(pieceId: string | null): pieceId is string {
  return sourcePieceName(pieceId) !== null;
}

/** The piece's name, or null when there is no such piece (see `sourcePieceExists`). */
export function sourcePieceName(pieceId: string | null): string | null {
  if (!pieceId) return null;
  return getDb().select({ name: pieces.name }).from(pieces).where(eq(pieces.id, pieceId)).get()?.name ?? null;
}

export async function readInstructions(id: string): Promise<string> {
  const p = path.join(templateDir(id), INSTRUCTIONS_FILE);
  let st: Awaited<ReturnType<typeof fs.lstat>>;
  try {
    st = await fs.lstat(p);
  } catch {
    return "";
  }
  if (st.isSymbolicLink()) throw new Error("index.md is a symlink");
  if (st.size > TEMPLATE_LIMITS.instructionsBytes) throw new Error("index.md over 32 KB");
  return fs.readFile(p, "utf8");
}

export async function readScaffold(
  id: string,
): Promise<{ ok: true; scaffold: TemplateScaffold } | { ok: false; reason: string }> {
  const dir = templateDir(id);
  const p = path.join(dir, SCAFFOLD_FILE);
  let st: Awaited<ReturnType<typeof fs.lstat>>;
  try {
    st = await fs.lstat(p);
  } catch {
    return { ok: false, reason: "template.json missing" };
  }
  if (st.isSymbolicLink()) return { ok: false, reason: "template.json is a symlink" };
  if (st.size > TEMPLATE_LIMITS.scaffoldBytes) return { ok: false, reason: "template.json over 256 KB" };
  let raw: unknown;
  try {
    raw = JSON.parse(await fs.readFile(p, "utf8"));
  } catch {
    return { ok: false, reason: "template.json is not valid JSON" };
  }
  const v = validateScaffold(raw);
  if (!v.ok) return v;
  for (const o of v.scaffold.overlays) {
    if (!o.codeFile) continue;
    const problem = await entryProblem(dir, o.codeFile, TEMPLATE_LIMITS.codeFileBytes);
    if (problem) return { ok: false, reason: problem };
  }
  for (const a of v.scaffold.assets) {
    if (!a.file) continue;
    const problem = await entryProblem(dir, a.file);
    if (problem) return { ok: false, reason: problem };
  }
  return v;
}

/** Why a file the scaffold names is unusable, or null when it is fine. The
 *  symlink check is per-FILE and the containment check covers the folders
 *  above it, so neither `assets/logo.png -> /etc/hosts` nor a symlinked
 *  `assets/` reaches a reader. */
async function entryProblem(dir: string, rel: string, maxBytes?: number): Promise<string | null> {
  let st: Awaited<ReturnType<typeof fs.lstat>>;
  try {
    st = await fs.lstat(path.join(dir, rel));
  } catch {
    return `${rel} missing`;
  }
  if (st.isSymbolicLink()) return `${rel} is a symlink`;
  try {
    await resolveWithin(dir, rel);
  } catch {
    return `${rel} escapes the template folder`;
  }
  if (maxBytes !== undefined && st.size > maxBytes) return `${rel} over ${Math.round(maxBytes / 1024)} KB`;
  return null;
}

/** `row` as stored: its link is shown only when it is this catalog's, else noted in `otherCatalog`. */
async function summarize(stored: TemplateRow, uses7d: Map<string, number>): Promise<TemplateSummary> {
  const row = seenHere(stored);
  const read = await readScaffold(row.id);
  const dir = templateDir(row.id);
  const [posterMtime, exampleMtime] = await Promise.all([
    mtimeMs(path.join(dir, POSTER_FILE)),
    mtimeMs(path.join(dir, EXAMPLE_FILE)),
  ]);
  const hasPoster = posterMtime !== null;
  const hasExample = exampleMtime !== null;
  const s = read.ok ? read.scaffold : null;
  const media = (name: string) => `/api/templates/${encodeURIComponent(row.id)}/media/${name}`;
  // Render preview renders the source piece as it is NOW: the card names it (one indexed lookup).
  const sourceName = row.origin === "local" ? sourcePieceName(row.createdFromPieceId) : null;
  const slots = s?.slots ?? [];
  return {
    id: row.id,
    cloudId: row.cloudId,
    name: row.name,
    description: row.description,
    tags: JSON.parse(row.tags) as string[],
    origin: row.origin,
    version: row.version,
    hasCode: row.hasCode,
    slots,
    slotCount: slots.length,
    canvas: s ? { width: s.canvas.width, height: s.canvas.height, fps: s.canvas.fps } : { width: 1920, height: 1080, fps: 30 },
    duration: s?.duration ?? 0,
    usesTotal: row.useCount,
    uses7d: uses7d.get(row.id) ?? 0,
    lastUsedAt: row.lastUsedAt ? row.lastUsedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    hasPoster,
    hasExample,
    poster: hasPoster ? media(POSTER_FILE) : null,
    video: hasExample ? media(EXAMPLE_FILE) : null,
    nickname: null,
    broken: read.ok ? null : read.reason,
    otherCatalog: otherCatalogOf(stored),
    mediaRev: Math.round(Math.max(posterMtime ?? 0, exampleMtime ?? 0)),
    canRenderExample: sourceName !== null,
    sourcePieceName: sourceName,
    sourceEmpty: row.origin === "local" && s !== null && s.overlays.length === 0 && s.audioClips.length === 0,
  };
}

export async function getTemplateSummary(id: string): Promise<TemplateSummary | null> {
  const row = getTemplateRecord(id);
  return row ? summarize(row, uses7dByTemplate()) : null;
}

/** `rank` (bm25, lower is better) breaks ties within the chosen order. */
function orderRows(
  rows: TemplateRow[],
  uses7d: Map<string, number>,
  order: TemplateOrder,
  rank?: Map<string, number>,
): TemplateRow[] {
  const tie = (a: TemplateRow, b: TemplateRow) => (rank ? (rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0) : 0);
  const byUpdated = (a: TemplateRow, b: TemplateRow) => b.updatedAt.getTime() - a.updatedAt.getTime();
  return [...rows].sort((a, b) => {
    if (order === "newest") return b.createdAt.getTime() - a.createdAt.getTime() || tie(a, b);
    if (order === "most-used") return b.useCount - a.useCount || byUpdated(a, b) || tie(a, b);
    return (uses7d.get(b.id) ?? 0) - (uses7d.get(a.id) ?? 0) || b.useCount - a.useCount || byUpdated(a, b) || tie(a, b);
  });
}

/**
 * The cached public catalog. A stale copy is served as it is and refreshed in
 * the background; only a first read with no copy waits on the network (best
 * effort: offline serves the last copy, or none). `match` narrows through the same FTS
 * table; the hits' bm25 rank lands in `rank` for a merged sort.
 */
async function publicSummaries(order: TemplateOrder, match: string | null, rank?: Map<string, number>): Promise<TemplateSummary[]> {
  await ensureCatalogForRead();
  if (!match) return catalogSummaries({ order });
  const hits = ftsSearch(getDb(), { match, scope: "public", limit: FTS_CANDIDATES });
  for (const h of hits) rank?.set(h.refId, h.rank);
  return catalogSummaries({ ids: hits.map((h) => h.refId), order });
}

/**
 * `all` = local first-class, plus the public entries not already among them.
 * A public entry is hidden only by a local row IN THIS RESULT carrying its
 * cloudId — a local row the search missed (renamed, filtered out) must not
 * take the public hit down with it.
 */
function mergeAll(local: TemplateSummary[], pub: TemplateSummary[], order: TemplateOrder, rank?: Map<string, number>): TemplateSummary[] {
  const have = new Set(local.flatMap((l) => (l.cloudId ? [l.cloudId] : [])));
  return [...local, ...pub.filter((p) => !have.has(p.cloudId ?? ""))].sort(compareSummaries(order, rank));
}

export async function listTemplates(
  opts: { order?: TemplateOrder; scope?: TemplateScope } = {},
): Promise<TemplateSummary[]> {
  const order = opts.order ?? "trending";
  const scope = opts.scope ?? "local";
  if (scope === "public") return publicSummaries(order, null);
  const uses7d = uses7dByTemplate();
  const rows = orderRows(getDb().select().from(templates).all(), uses7d, order);
  const local = await Promise.all(rows.map((r) => summarize(r, uses7d)));
  if (scope === "local") return local;
  return mergeAll(local, await publicSummaries(order, null), order);
}

export async function searchTemplates(opts: {
  query: string;
  tags?: string[];
  scope?: TemplateScope;
  order?: TemplateOrder;
  limit?: number;
}): Promise<TemplateSummary[]> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const tagFilter = normalizeTags(opts.tags ?? []);
  const keep = (t: TemplateSummary) => tagFilter.every((tag) => t.tags.includes(tag));
  const order = opts.order ?? "trending";
  const scope = opts.scope ?? "local";
  const match = opts.query.trim().length < 2 ? null : buildMatchExpression(tokenize(opts.query));
  if (!match) {
    return (await listTemplates({ order, scope })).filter(keep).slice(0, limit);
  }
  const rank = new Map<string, number>();
  let local: TemplateSummary[] = [];
  if (scope !== "public") {
    const hits = ftsSearch(getDb(), { match, scope: "local", limit: FTS_CANDIDATES });
    for (const h of hits) rank.set(h.refId, h.rank);
    if (hits.length > 0) {
      const rows = getDb()
        .select()
        .from(templates)
        .where(inArray(templates.id, hits.map((h) => h.refId)))
        .all();
      const uses7d = uses7dByTemplate();
      const ordered = orderRows(rows, uses7d, order, rank);
      local = await Promise.all(ordered.map((r) => summarize(r, uses7d)));
    }
  }
  if (scope === "local") return local.filter(keep).slice(0, limit);
  const pub = await publicSummaries(order, match, rank);
  const merged = scope === "public" ? pub : mergeAll(local.filter(keep), pub, order, rank);
  return merged.filter(keep).slice(0, limit);
}

export async function updateTemplate(id: string, patch: UpdateTemplatePatch): Promise<TemplateRow | null> {
  const row = getTemplate(id);
  if (!row) return null;
  const set: Partial<typeof templates.$inferInsert> = { updatedAt: new Date(), version: row.version + 1 };
  if (patch.name !== undefined) {
    if (patch.name.trim().length === 0 || patch.name.length > TEMPLATE_LIMITS.nameChars) throw new Error("name: 1–80 chars");
    set.name = patch.name;
  }
  if (patch.description !== undefined) {
    if (patch.description.length > TEMPLATE_LIMITS.descriptionChars) throw new Error("description: ≤ 500 chars");
    set.description = patch.description;
  }
  if (patch.tags !== undefined) {
    const tags = normalizeTags(patch.tags);
    const problem = tagsError(tags);
    if (problem) throw new Error(problem);
    set.tags = JSON.stringify(tags);
  }
  const meta = {
    name: set.name ?? row.name,
    description: set.description ?? row.description,
    tags: JSON.parse((set.tags as string | undefined) ?? row.tags) as string[],
  };
  const dir = templateDir(id);
  if (patch.replace) {
    // Build the replacement in a sibling folder first: a missing copy source, an
    // oversize code body or an invalid scaffold must leave the LIVE template
    // exactly as it was, not gutted with a template.json naming deleted files.
    const staging = `${dir}.replace-${crypto.randomBytes(6).toString("hex")}`;
    await fs.mkdir(staging, { recursive: true });
    let scaffold: TemplateScaffold;
    try {
      scaffold = await writeFolderContents(
        staging,
        { ...patch.replace.scaffold, ...meta },
        patch.replace.copies,
        patch.replace.writes,
      );
    } catch (err) {
      await fs.rm(staging, { recursive: true, force: true });
      logger.error(
        { tag: TEMPLATES_LOG_TAG, op: "update_replace_failed", templateId: id, err: err instanceof Error ? err.message : String(err) },
        "template replace failed, original kept",
      );
      throw err;
    }
    try {
      await swapReplacement(dir, staging);
    } finally {
      await fs.rm(staging, { recursive: true, force: true });
    }
    set.hasCode = scaffoldHasCode(scaffold);
  } else if (set.name !== undefined || set.description !== undefined || set.tags !== undefined) {
    // Keep template.json's own name/description/tags in step with the row.
    const read = await readScaffold(id);
    if (read.ok) await writeScaffoldFile(dir, { ...read.scaffold, ...meta });
  }
  const [updated] = getDb().update(templates).set(set).where(eq(templates.id, id)).returning().all();
  logger.info(
    { tag: TEMPLATES_LOG_TAG, op: "update", templateId: id, version: updated.version, replaced: patch.replace !== undefined },
    "template updated",
  );
  return seenHere(updated);
}

/**
 * Record a successful publish (the `template_publish` job's last step). The
 * row gains its catalog id FIRST — the template is public now, and a row
 * without the id would publish a duplicate next time — its pending publish
 * is cleared in the same write, and its version bumps
 * so cached media URLs (`?v=`) reload. Then the example and poster that went
 * public become the local template's own, each through a temp name and a
 * rename; a failure there is logged, never thrown: the publish stands.
 * `origin` stays "local". The link is recorded as this catalog's.
 */
export async function markTemplatePublished(
  id: string,
  opts: { cloudId: string; examplePath: string; posterPath: string },
): Promise<TemplateRow | null> {
  const row = getTemplate(id);
  if (!row) return null;
  const [updated] = getDb()
    .update(templates)
    .set({ cloudId: opts.cloudId, cloudSource: catalogSource(), publishPending: null, version: row.version + 1, updatedAt: new Date() })
    .where(eq(templates.id, id))
    .returning()
    .all();
  const dir = templateDir(id);
  for (const [from, name] of [[opts.examplePath, EXAMPLE_FILE], [opts.posterPath, POSTER_FILE]] as const) {
    const dest = path.join(dir, name);
    const tmp = `${dest}.publish-${crypto.randomBytes(6).toString("hex")}`;
    try {
      await fs.copyFile(from, tmp);
      await fs.rename(tmp, dest);
    } catch (err) {
      await fs.rm(tmp, { force: true });
      logger.warn(
        { tag: TEMPLATES_LOG_TAG, op: "publish_media_copy_failed", templateId: id, file: name, err: err instanceof Error ? err.message : String(err) },
        "published media not kept locally",
      );
    }
  }
  return updated ?? null;
}

/** Job statuses of a publish that has not finished. */
const LIVE_PUBLISH_STATUSES = ["queued", "running", "cancel-requested"] as const;

type ReadDb = Pick<ReturnType<typeof getDb>, "select">;

/**
 * Template ids with a `template_publish` job that has not finished. Read
 * from the jobs table directly (the MCP child reads it too, and may not import
 * `lib/jobs/*`).
 */
export function publishingTemplateIds(db: ReadDb = getDb()): Set<string> {
  const rows = db
    .select({ paramsJson: jobs.paramsJson })
    .from(jobs)
    .where(and(eq(jobs.kind, "template_publish"), inArray(jobs.status, [...LIVE_PUBLISH_STATUSES])))
    .all();
  const ids = new Set<string>();
  for (const r of rows) {
    try {
      const p = JSON.parse(r.paramsJson) as { templateId?: unknown };
      if (typeof p.templateId === "string") ids.add(p.templateId);
    } catch {
      // A job row libi cannot read names no template.
    }
  }
  return ids;
}

/** Job statuses of an example render that has not finished. */
const LIVE_EXAMPLE_STATUSES = ["queued", "running", "cancel-requested"] as const;
/** The longest failure reason the Templates page is handed for a card. */
export const EXAMPLE_FAILURE_MAX = 300;

/**
 * Where each template's example render stands, read from the jobs table (as
 * `publishingTemplateIds` is):
 *  - `rendering`: templates with a `template_example` render queued or
 *    running — the Templates page names the wait on those cards;
 *  - `failed`: templates whose LAST render failed, with why (the job's own
 *    error, already scrubbed of secrets by JobManager, clamped) — so a card
 *    that went back to "Render preview" says what went wrong (D2–D4 review M1).
 *    A cancelled render is not a failure.
 */
export function exampleRenderStatus(db: ReadDb = getDb()): { rendering: Set<string>; failed: Map<string, string> } {
  const rows = db
    .select({ paramsJson: jobs.paramsJson, status: jobs.status, error: jobs.error, createdAt: jobs.createdAt })
    .from(jobs)
    .where(eq(jobs.kind, "template_example"))
    .orderBy(desc(jobs.createdAt))
    .all();
  const rendering = new Set<string>();
  const failed = new Map<string, string>();
  const seen = new Set<string>();
  for (const r of rows) {
    let templateId: unknown;
    try {
      templateId = (JSON.parse(r.paramsJson) as { templateId?: unknown }).templateId;
    } catch {
      continue; // A job row libi cannot read names no template.
    }
    if (typeof templateId !== "string") continue;
    if ((LIVE_EXAMPLE_STATUSES as readonly string[]).includes(r.status)) rendering.add(templateId);
    // Newest first: only a template's latest render says whether it failed.
    if (seen.has(templateId)) continue;
    seen.add(templateId);
    if (r.status === "failed") {
      const why = (r.error ?? "").replace(/\s+/g, " ").trim() || "The render failed.";
      failed.set(templateId, why.length > EXAMPLE_FAILURE_MAX ? `${why.slice(0, EXAMPLE_FAILURE_MAX - 1)}…` : why);
    }
  }
  for (const id of rendering) failed.delete(id);
  return { rendering, failed };
}

/** Template ids with an example render queued or running (`exampleRenderStatus().rendering`). */
export function renderingExampleTemplateIds(db: ReadDb = getDb()): Set<string> {
  return exampleRenderStatus(db).rendering;
}

/** A leftover of an interrupted `setTemplateExample`: a staged copy or a backup of the old pair. */
const EXAMPLE_SWAP_LEFTOVER = /^\.(?:example|poster)-[0-9a-f]{12}\.(?:new|old)$/;

/**
 * Make `examplePath` / `posterPath` the template's own example.mp4 and
 * poster.jpg (the `template_example` job's last step) — as a PAIR, never a
 * new example beside the old poster (D2–D4 review M5):
 *  1. both new files are copied in under staging names first; a failed copy
 *     changes nothing;
 *  2. the current pair is moved aside to backup names;
 *  3. the staged pair is renamed into place; if either rename fails, what
 *     was renamed is taken back out and the backups are restored;
 *  4. the backups are removed.
 * A reader sees the old pair, the new pair, or — only for the instant between
 * steps 2 and 3, or after a crash there — a missing file, which reads as "no
 * example yet"; never a mismatched pair. Leftovers of an interrupted swap are
 * swept at the start of the next one. None of these names is one a publish
 * lists (lib/templates/cloud/preflight.ts#manifestFor reads fixed names and
 * `overlays/`, `assets/` only). Refuses a template that no longer exists.
 */
export async function setTemplateExample(id: string, examplePath: string, posterPath: string): Promise<void> {
  if (!getTemplateRecord(id)) throw new Error("template_not_found");
  const dir = templateDir(id);
  for (const name of await fs.readdir(dir)) {
    if (EXAMPLE_SWAP_LEFTOVER.test(name)) await fs.rm(path.join(dir, name), { force: true });
  }
  const hex = crypto.randomBytes(6).toString("hex");
  const pair = [
    { from: examplePath, dest: path.join(dir, EXAMPLE_FILE), stem: "example" },
    { from: posterPath, dest: path.join(dir, POSTER_FILE), stem: "poster" },
  ].map((f) => ({ ...f, staged: path.join(dir, `.${f.stem}-${hex}.new`), backup: path.join(dir, `.${f.stem}-${hex}.old`) }));
  const cleanup = async (names: string[]) => {
    for (const n of names) await fs.rm(n, { force: true });
  };
  try {
    for (const f of pair) await fs.copyFile(f.from, f.staged);
  } catch (err) {
    await cleanup(pair.map((f) => f.staged));
    throw err;
  }
  const backedUp: typeof pair = [];
  const placed: typeof pair = [];
  try {
    for (const f of pair) {
      try {
        await fs.rename(f.dest, f.backup);
        backedUp.push(f);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err; // no current file: nothing to back up
      }
    }
    for (const f of pair) {
      await fs.rename(f.staged, f.dest);
      placed.push(f);
    }
  } catch (err) {
    // Back to the old pair (or to none, as it was).
    for (const f of placed) await fs.rm(f.dest, { force: true });
    for (const f of backedUp) await fs.rename(f.backup, f.dest).catch(() => undefined);
    await cleanup(pair.map((f) => f.staged));
    throw err;
  }
  await cleanup(pair.map((f) => f.backup));
}

/** Said when a template is deleted while its publish is still running. */
export const DELETE_WHILE_PUBLISHING =
  "This template is publishing right now. Wait for the publish to finish, or stop it, then delete the template.";

/**
 * Said after deleting a template that was published: deleting the local copy
 * does not take the public one down.
 */
export const DELETED_PUBLISHED_NOTE =
  "Its public copy stays in the catalog: to take it down, hide it under \"Your templates\" in List view on the Templates page.";

/**
 * Delete the row and its folders. `"publishing"` (nothing deleted) while a
 * publish of it is still running — the job would otherwise go on uploading a
 * template that no longer exists here. Returns the deleted row's `cloudId`
 * when it is the user's OWN published template (null otherwise — never
 * published, or installed from someone else) so the caller can say the
 * public copy stays.
 */
export async function deleteTemplate(id: string): Promise<{ deleted: true; cloudId: string | null } | { deleted: false; reason: "not_found" | "publishing" }> {
  const outcome = getDb().transaction((tx) => {
    if (publishingTemplateIds(tx).has(id)) return "publishing" as const;
    // Its publish requests go with it (FK cascade); their example and poster folders are ours to remove.
    const requestIds = tx.select({ id: templatePublishRequests.id }).from(templatePublishRequests).where(eq(templatePublishRequests.templateId, id)).all().map((r) => r.id);
    const [row] = tx.delete(templates).where(eq(templates.id, id)).returning().all();
    return row ? { row, requestIds } : null;
  });
  if (outcome === "publishing") return { deleted: false, reason: "publishing" };
  if (!outcome) return { deleted: false, reason: "not_found" };
  const deleted = outcome.row;
  for (const requestId of outcome.requestIds) removePublishRequestMedia(requestId);
  await fs.rm(templateDir(id), { recursive: true, force: true });
  await fs.rm(publishWorkDir(id), { recursive: true, force: true });
  logger.info({ tag: TEMPLATES_LOG_TAG, op: "delete", templateId: id, published: deleted.cloudId !== null }, "template deleted");
  // Only the user's own published template has a public copy of theirs; an installed one is someone else's.
  return { deleted: true, cloudId: deleted.origin === "local" ? deleted.cloudId : null };
}

/**
 * The catalog a use is recorded for: an installed template's OWN catalog (the
 * one it came from — a dev build may have switched away since), otherwise the
 * catalog this process reads. Test mode always records its own marker, so a
 * use made in test mode never reaches a real site.
 */
export function useSourceFor(row: { origin: string; cloudId: string | null; cloudSource: string | null } | null): string {
  const here = catalogSource();
  if (here === TEST_MODE_SOURCE) return here;
  if (row?.origin === "installed" && row.cloudId) return recordedSource(row.cloudSource);
  return here;
}

/** The use row and the denormalised counters move together or not at all. */
export function recordUse(templateId: string, pieceId: string | null): void {
  getDb().transaction((tx) => {
    const row = tx.select({ origin: templates.origin, cloudId: templates.cloudId, cloudSource: templates.cloudSource }).from(templates).where(eq(templates.id, templateId)).get();
    // Recorded with the catalog it is to be told to — only that one ever is (lib/templates/cloud/use-reporter.ts).
    tx.insert(templateUses).values({ templateId, pieceId, source: useSourceFor(row ?? null) }).run();
    tx.update(templates)
      .set({ useCount: sql`${templates.useCount} + 1`, lastUsedAt: new Date() })
      .where(eq(templates.id, templateId))
      .run();
  });
}

/** What `lstat` finds at `abs`, or null when nothing is there. */
async function lstatOrNull(abs: string): Promise<Stats | null> {
  try {
    return await fs.lstat(abs);
  } catch {
    return null;
  }
}

/** Refuse `rel` inside a folder being imported unless it is a regular file,
 *  not a symlink, really inside `srcDir` (a symlinked parent folder is caught
 *  by the realpath check), and at most `maxBytes`. Returns its size. */
async function checkImportFile(srcDir: string, rel: string, maxBytes: number): Promise<number> {
  assertRel(rel);
  const st = await lstatOrNull(path.join(srcDir, rel));
  if (!st) throw new Error(`import refused: ${rel} missing`);
  if (st.isSymbolicLink()) throw new Error(`import refused: ${rel} is a symlink`);
  if (!st.isFile()) throw new Error(`import refused: ${rel} is not a regular file`);
  // A hard link is a regular file that may share its bytes with one outside
  // the folder (a tar extractor can create one), so it is refused like a symlink.
  if (st.nlink > 1) throw new Error(`import refused: ${rel} is a hard link`);
  try {
    await resolveWithin(srcDir, rel);
  } catch {
    throw new Error(`import refused: ${rel} escapes the template folder`);
  }
  if (st.size > maxBytes) throw new Error(`import refused: ${rel} over ${maxBytes} bytes`);
  return st.size;
}

/** Read a small text file of a folder being imported, under the same checks. */
async function readImportFile(srcDir: string, rel: string, maxBytes: number): Promise<string> {
  await checkImportFile(srcDir, rel, maxBytes);
  let handle: fs.FileHandle;
  try {
    handle = await openRegularFile(path.join(srcDir, rel), rel, maxBytes);
  } catch (err) {
    throw new Error(`import refused: ${err instanceof Error ? err.message : String(err)}`);
  }
  try {
    return await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
}

/**
 * Replace an INSTALLED template's folder and row with a newer import of the
 * same catalog template. The new folder is built complete in a sibling
 * staging folder, then swapped in whole: the old one goes aside and is removed
 * only once the new one is in place and the row says so, so a failure at any
 * step leaves the old template exactly as it was. The row keeps its id — apply
 * prompts, uses and the page keep pointing at it.
 */
async function replaceInstalledTemplate(
  id: string,
  input: Omit<CreateTemplateInput, "id" | "origin" | "createdFromPieceId">,
): Promise<TemplateRow> {
  const row = getTemplate(id);
  if (!row) throw new Error("template_not_found");
  if (row.origin !== "installed") throw new Error("only an installed template is replaced by an import");
  const tags = checkedMetadata(input);
  const dir = templateDir(id);
  const suffix = crypto.randomBytes(6).toString("hex");
  const staging = `${dir}.import-${suffix}`;
  const aside = `${dir}.old-${suffix}`;
  await fs.mkdir(staging);
  let scaffold: TemplateScaffold;
  try {
    scaffold = await writeFolderContents(staging, { ...input.scaffold, name: input.name, description: input.description, tags }, input.copies, input.writes);
    await fs.writeFile(path.join(staging, INSTRUCTIONS_FILE), input.instructions, "utf8");
  } catch (err) {
    await fs.rm(staging, { recursive: true, force: true });
    throw err;
  }
  // `rename` moves a symlink planted at `dir` itself, never what it points at.
  const hadDir = (await lstatOrNull(dir)) !== null;
  if (hadDir) await fs.rename(dir, aside);
  let updated: TemplateRow;
  try {
    await fs.rename(staging, dir);
    [updated] = getDb()
      .update(templates)
      .set({
        name: input.name,
        description: input.description,
        tags: JSON.stringify(tags),
        cloudId: input.cloudId ?? row.cloudId,
        cloudSource: catalogSource(),
        version: input.version ?? row.version,
        hasCode: scaffoldHasCode(scaffold),
        updatedAt: new Date(),
      })
      .where(eq(templates.id, id))
      .returning()
      .all();
  } catch (err) {
    // The new folder may or may not be in place: take it out, put the old one back.
    if (await lstatOrNull(staging)) await fs.rm(staging, { recursive: true, force: true });
    else await fs.rm(dir, { recursive: true, force: true });
    if (hadDir) {
      await fs.rename(aside, dir).catch((restoreErr: unknown) =>
        logger.error(
          { tag: TEMPLATES_LOG_TAG, op: "import_replace_rollback_incomplete", templateId: id, aside, err: restoreErr instanceof Error ? restoreErr.message : String(restoreErr) },
          "installed template replace rollback incomplete, the original is kept in the aside folder",
        ),
      );
    }
    throw err;
  }
  await fs.rm(aside, { recursive: true, force: true });
  logger.info({ tag: TEMPLATES_LOG_TAG, op: "import_replace", templateId: id, version: updated.version }, "installed template replaced");
  return updated;
}

/**
 * Copy a template folder (an export, or a catalog download) into the store.
 *
 * The folder is HOSTILE input — a stranger built it. Before anything is written,
 * every file the scaffold names (and `index.md`, `poster.jpg`, `example.mp4`)
 * must be a regular file inside `srcDir`: a symlink, a hard link, or a file
 * reached through a symlinked folder, is refused rather than followed, so `assets/logo.png ->
 * ~/.ssh/id_ed25519` never becomes a template's bytes. The store's own caps
 * apply as well — `template.json` 256 KB, a code file 128 KB, `index.md` 32 KB,
 * each copied file `assetBytes`, all of them `totalBytes`, and the scaffold's
 * own counts (30 assets, 60 overlays). Any violation rejects the WHOLE import.
 * The copies re-check the kind and size on the handle they read from.
 *
 * `metadata` names the row (and the written template.json) in place of the
 * folder's own template.json: a catalog listing whose owner renamed it after
 * publishing is shown as the listing says. `replaceId` rebuilds that INSTALLED
 * template's folder and row in place (a newer catalog version) instead of
 * creating a new one.
 */
export async function importTemplateFolder(
  srcDir: string,
  opts: {
    origin: "local" | "installed";
    cloudId?: string | null;
    version?: number;
    createdFromPieceId?: string | null;
    metadata?: { name: string; description: string; tags: string[] };
    replaceId?: string;
  },
): Promise<TemplateRow> {
  const scaffoldText = await readImportFile(srcDir, SCAFFOLD_FILE, TEMPLATE_LIMITS.scaffoldBytes);
  let raw: unknown;
  try {
    raw = JSON.parse(scaffoldText);
  } catch {
    throw new Error("invalid scaffold: template.json is not valid JSON");
  }
  const v = validateScaffold(raw);
  if (!v.ok) throw new Error(`invalid scaffold: ${v.reason}`);

  const copies: CreateTemplateInput["copies"] = [];
  let total = 0;
  const addCopy = async (rel: string) => {
    total += await checkImportFile(srcDir, rel, TEMPLATE_LIMITS.assetBytes);
    if (total > TEMPLATE_LIMITS.totalBytes) throw new Error(`import refused: files over ${TEMPLATE_LIMITS.totalBytes} bytes in total`);
    copies.push({ rel, from: path.join(srcDir, rel) });
  };
  for (const a of v.scaffold.assets) if (a.file) await addCopy(a.file);
  for (const extra of [POSTER_FILE, EXAMPLE_FILE]) {
    if (await lstatOrNull(path.join(srcDir, extra))) await addCopy(extra);
  }
  const writes: CreateTemplateInput["writes"] = [];
  for (const o of v.scaffold.overlays) {
    if (o.codeFile) writes.push({ rel: o.codeFile, body: await readImportFile(srcDir, o.codeFile, TEMPLATE_LIMITS.codeFileBytes) });
  }
  const instructions = (await lstatOrNull(path.join(srcDir, INSTRUCTIONS_FILE)))
    ? await readImportFile(srcDir, INSTRUCTIONS_FILE, TEMPLATE_LIMITS.instructionsBytes)
    : "";
  const meta = opts.metadata ?? { name: v.scaffold.name, description: v.scaffold.description, tags: v.scaffold.tags };
  if (opts.replaceId !== undefined) {
    return replaceInstalledTemplate(opts.replaceId, {
      ...meta,
      cloudId: opts.cloudId ?? null,
      version: opts.version,
      scaffold: v.scaffold,
      instructions,
      copies,
      writes,
    });
  }
  return createTemplate({
    ...meta,
    origin: opts.origin,
    cloudId: opts.cloudId ?? null,
    version: opts.version,
    createdFromPieceId: opts.createdFromPieceId ?? null,
    scaffold: v.scaffold,
    instructions,
    copies,
    writes,
  });
}
