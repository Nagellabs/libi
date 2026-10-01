/**
 * Install a public template: download `templates/<id>/v<n>/*` from the
 * catalog bucket, hold every byte to the site's rules, and hand the folder to
 * the store's import (`importTemplateFolder`, which re-checks it as hostile).
 *
 * This is where a STRANGER's content enters the user's machine, so nothing
 * the catalog says is taken on trust, even though the client
 * (lib/templates/cloud/client.ts) has already validated its shape:
 *  - Where: every request (and every redirect hop) must stay under this
 *    environment's bucket base AND this template's version folder, compared
 *    on the parsed, normalised URL (`bucketOnlyGuard`) — never a string prefix
 *    — and still passes the SSRF guard.
 *  - How much: ≤ 60 files, each at most the site's cap for its name (image
 *    2 MB, font 4 MB, code 128 KB, template.json 256 KB, index.md 32 KB,
 *    poster 400 KB, example 8 MB), 24 MB together. The body is streamed under
 *    the manifest's declared size, so a server that lies about the size — or
 *    sends a compressed bomb — is cut off while streaming, not after.
 *  - What: exactly the declared size and md5; text files valid UTF-8 under the
 *    site's text rules; the poster a JPEG and the example an MP4; every asset
 *    file a real image or font of the kind its scaffold entry says. A
 *    scaffold asset that is not media, or a file nothing in the scaffold
 *    names, makes the template BROKEN — refused whole, never auto-slotted.
 *  - Agreement: the scaffold (validated like any local template, keyframe
 *    tracks included) must agree with the catalog's document and cached index
 *    entry on version, code, canvas, duration and slot count. An older version
 *    than the one installed, or than the index lists, is a rollback: refused.
 *  - Code: refused while PUBLIC_CODE_TEMPLATES is false. When it flips, every
 *    body must still pass the same validators `add_overlay` applies before a
 *    byte is written.
 *
 * The listing's CURRENT name, description and tags (the catalog document,
 * which its owner may have edited since publishing) name the installed row —
 * template.json's own copies are publish-time values and are not shown.
 * Those strings are still the author's: whatever hands them to an agent labels
 * them `source: "template author (untrusted)"` (mcp/tools/template-tools.ts).
 *
 * Never throws: every failure is `{ ok: false, error }`, printable ASCII.
 */
import crypto from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { and, desc, eq } from "drizzle-orm";
import { validateDrawFunction, validateThreeFunction } from "@/lib/ai/scene-validator";
import { trackServerEvent } from "@/lib/analytics/server";
import { getDb } from "@/lib/db/client";
import { templates } from "@/lib/db/schema/sqlite";
import type { TemplateRow } from "@/lib/db/schema/types";
import { getCurrentPort } from "@/lib/libi-home";
import { serverLogger as logger } from "@/lib/logger";
import { readBodyWithCap } from "@/lib/net/fetch-and-store";
import { fetchFollowingVettedRedirects, type UrlGuard } from "@/lib/net/follow-redirects";
import { assertLoopbackOrPublicHttpUrl, assertPublicHttpUrl } from "@/lib/net/url-guard";
import { isTestMode } from "@/lib/test-mode";
import { getCatalogEntry } from "@/lib/templates/cloud/catalog-cache";
import { catalogBucketBaseFor } from "@/lib/templates/cloud/catalog-source";
import { getCloudTemplate, isNoSuchTemplate, type CloudTemplate } from "@/lib/templates/cloud/client";
import {
  CAPS,
  CLOUD_FILE_NAME_PATTERN,
  CLOUD_ID_PATTERN,
  MAX_FILES,
  PUBLIC_CODE_TEMPLATES,
} from "@/lib/templates/cloud/constants";
import { capForName, contentTypeForName, hasCodeIn, hostedUrlProblem, scaffoldValueProblems, textFileProblem } from "@/lib/templates/cloud/preflight";
import { MIN_VISIBLE_NAME_CHARS, edgeTextProblem, multiLineTextProblem, singleLineTextProblem, visibleCharCount } from "@/lib/templates/cloud/text-rules";
import { normalizeTags, reasonWithoutTemplateText, tagsError, validateScaffold, TEMPLATE_LIMITS, type TemplateScaffold } from "@/lib/templates/scaffold";
import { importTemplateFolder, isCloudIdTaken, linkedToThisCatalog, templatesRoot } from "@/lib/templates/store";

/**
 * Why an install failed, as a fixed code. `error` beside it is for the agent
 * and the log — it can carry the site's words or the network stack's — so the
 * Templates page switches on `code` and shows libi's own copy.
 */
export type InstallErrorCode =
  | "invalid_id"
  | "not_found"
  | "unreachable"
  | "rate_limited"
  | "catalog_error"
  | "download_failed"
  | "version_changed"
  | "older_version"
  | "code_blocked"
  | "rejected"
  | "stopped"
  | "failed"
  /** Not the install's own: the `template_install` job refused a catalog changed since it was queued (catalog-source.ts#catalogForQueuedJob). */
  | "catalog_changed";

export type InstallResult =
  | { ok: true; templateId: string; version: number; reinstalled: boolean }
  | { ok: false; error: string; code: InstallErrorCode };

/** One file of the download verified and held in memory: `doneBytes` of `totalBytes`, file `index` (1-based) of `count`. */
export interface InstallFileProgress {
  name: string;
  index: number;
  count: number;
  doneBytes: number;
  totalBytes: number;
}

export interface InstallOptions {
  /** Download the installed version again (the Templates page's "re-download"). */
  force?: boolean;
  /**
   * The version the caller expects (the one its listing showed). The catalog
   * serving another is refused rather than silently installing something the
   * user did not see; an installed copy already at it answers without a download.
   */
  version?: number;
  /** Stops the download between and during files: the install then answers `{ ok: false }` and writes nothing. */
  signal?: AbortSignal;
  /** After each file is downloaded and verified. A throw stops the install, as `signal` does. */
  onFile?: (p: InstallFileProgress) => void | Promise<void>;
}

const TAG = "templates-cloud";
/** One file's download (headers and body). */
const FILE_TIMEOUT_MS = 60_000;
/** The whole install: 24 MB on a slow link, with room to spare. */
const INSTALL_TIMEOUT_MS = 5 * 60_000;
/** The reason a stopped install answers with. */
const STOPPED = "the install was stopped";
const MAX_ERROR_CHARS = 300;

export const CODE_TEMPLATES_INSTALL_BLOCKED = "Templates with code can't be installed yet";

/** A message for the caller (an agent, the Templates page): printable ASCII, bounded. */
function printable(s: string): string {
  const flat = s.replace(/[^\x20-\x7e]/g, "?");
  return flat.length > MAX_ERROR_CHARS ? `${flat.slice(0, MAX_ERROR_CHARS - 3)}...` : flat;
}

class InstallRefusal extends Error {
  constructor(
    message: string,
    readonly code: InstallErrorCode,
  ) {
    super(message);
  }
}
const refuse = (msg: string, code: InstallErrorCode = "rejected"): never => {
  throw new InstallRefusal(msg, code);
};

// ---------------------------------------------------------------------------
// Where: the bucket guard
// ---------------------------------------------------------------------------

/**
 * The SSRF guard, narrowed to one bucket folder. `base` (an http(s) URL
 * ending in "/") is parsed once; each URL — the first request and every
 * redirect hop — is parsed too, and must have base's exact origin and a
 * pathname under base's pathname, as the URL parser normalised them (`..`,
 * `%2e%2e` and `\` are resolved before the comparison, never a raw
 * `startsWith` on the text). No credentials, query, fragment or `%` escapes:
 * libi's own object URLs have none. Then the usual guard runs: public
 * addresses only (loopback to the studio's own port in test mode).
 */
export function bucketOnlyGuard(base: string): UrlGuard {
  const b = new URL(base);
  if (!b.pathname.endsWith("/")) throw new Error("bucketOnlyGuard: base must end with /");
  return async (raw: string) => {
    let u: URL;
    try {
      u = new URL(raw);
    } catch {
      throw new Error("refusing to fetch a malformed URL");
    }
    const outside =
      u.origin !== b.origin ||
      !u.pathname.startsWith(b.pathname) ||
      u.username !== "" ||
      u.password !== "" ||
      u.search !== "" ||
      u.hash !== "" ||
      u.pathname.includes("%");
    if (outside) throw new Error("refusing to fetch outside the catalog bucket");
    if (isTestMode()) return assertLoopbackOrPublicHttpUrl(u.href, getCurrentPort());
    if (u.protocol !== "https:") throw new Error("refusing to fetch the catalog bucket over plain http");
    return assertPublicHttpUrl(u.href);
  };
}

// ---------------------------------------------------------------------------
// What: the bytes
// ---------------------------------------------------------------------------

const IMAGE_EXT = /\.(jpg|jpeg|png|webp|svg)$/;
const FONT_EXT = /\.(ttf|otf|woff2)$/;

const startsWith = (buf: Buffer, bytes: number[], at = 0) => buf.length >= at + bytes.length && bytes.every((b, i) => buf[at + i] === b);
const ascii = (buf: Buffer, at: number, s: string) => buf.length >= at + s.length && buf.toString("latin1", at, at + s.length) === s;

/** A raster image in any of the formats the catalog admits (a `.png` holding JPEG bytes is still an image). */
function isRasterImage(buf: Buffer): boolean {
  return (
    startsWith(buf, [0xff, 0xd8, 0xff]) ||
    startsWith(buf, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) ||
    (ascii(buf, 0, "RIFF") && ascii(buf, 8, "WEBP"))
  );
}
function isFont(buf: Buffer): boolean {
  return startsWith(buf, [0x00, 0x01, 0x00, 0x00]) || ascii(buf, 0, "OTTO") || ascii(buf, 0, "true") || ascii(buf, 0, "wOF2");
}

/** Why these bytes are not what their name says, or null. */
function contentProblem(name: string, buf: Buffer): string | null {
  if (name === "poster.jpg") return startsWith(buf, [0xff, 0xd8, 0xff]) ? null : "poster.jpg is not a JPEG";
  if (name === "example.mp4") return ascii(buf, 4, "ftyp") ? null : "example.mp4 has no ftyp box - not an MP4";
  if (name === "template.json" || name === "index.md" || name.endsWith(".jsx")) return textFileProblem(name, buf);
  if (name.endsWith(".svg")) {
    const problem = textFileProblem(name, buf);
    if (problem) return problem;
    return /<svg[\s>]/i.test(buf.toString("utf8")) ? null : `${name} is not an SVG image`;
  }
  if (IMAGE_EXT.test(name)) return isRasterImage(buf) ? null : `${name} is not an image`;
  if (FONT_EXT.test(name)) return isFont(buf) ? null : `${name} is not a font`;
  return `${name} is not a file a template may carry`;
}

const md5 = (buf: Buffer) => crypto.createHash("md5").update(buf).digest("base64");

/**
 * Download one file under `folderUrl`, streamed under `declared` bytes. A
 * response that arrives compressed is refused before its body is read: the
 * catalog stores plain objects, and a decompressing reader is a way to turn a
 * small download into an unbounded one.
 */
async function download(folderUrl: string, guard: UrlGuard, f: CloudTemplate["files"][number], signal: AbortSignal): Promise<Buffer> {
  const url = new URL(f.name, folderUrl).href;
  const res = await fetchFollowingVettedRedirects(url, guard, {
    signal: AbortSignal.any([signal, AbortSignal.timeout(FILE_TIMEOUT_MS)]),
    headers: { "Accept-Encoding": "identity" },
    cache: "no-store",
  });
  const drop = () => void res.body?.cancel().catch(() => undefined);
  if (!res.ok) {
    drop();
    refuse(`file "${f.name}" answered ${res.status}`, "download_failed");
  }
  const encoding = (res.headers.get("content-encoding") ?? "").trim().toLowerCase();
  if (encoding !== "" && encoding !== "identity") {
    drop();
    refuse(`file "${f.name}" arrived compressed (${encoding}); the catalog serves plain files`);
  }
  const declaredLength = Number(res.headers.get("content-length"));
  if (res.headers.has("content-length") && Number.isFinite(declaredLength) && declaredLength > f.bytes) {
    drop();
    refuse(`file "${f.name}" is ${declaredLength} bytes, more than the manifest's ${f.bytes}`);
  }
  let buf: Buffer;
  try {
    buf = await readBodyWithCap(res, f.bytes);
  } catch (err) {
    return refuse(`file "${f.name}" is larger than the manifest's ${f.bytes} bytes or could not be read (${err instanceof Error ? err.message : String(err)})`, "download_failed");
  }
  if (buf.byteLength !== f.bytes) refuse(`file "${f.name}" is ${buf.byteLength} bytes, not the manifest's ${f.bytes}`);
  if (md5(buf) !== f.md5) refuse(`file "${f.name}" md5 differs from the manifest`);
  return buf;
}

// ---------------------------------------------------------------------------
// Checks on the catalog's documents and the scaffold
// ---------------------------------------------------------------------------

/** The manifest, before a single byte is fetched. */
function checkManifest(t: CloudTemplate): void {
  if (t.files.length > MAX_FILES) refuse(`template lists ${t.files.length} files (at most ${MAX_FILES})`);
  const names = new Set<string>();
  let total = 0;
  for (const f of t.files) {
    // The client checked this shape; a name is also a path on disk, so again here.
    if (typeof f.name !== "string" || !CLOUD_FILE_NAME_PATTERN.test(f.name) || f.name.split("/").includes("..")) {
      refuse(`file "${printable(String(f.name)).slice(0, 80)}" is not a name a template may carry`);
    }
    if (names.has(f.name)) refuse(`file "${f.name}" is listed twice`);
    names.add(f.name);
    const cap = capForName(f.name);
    if (!cap || contentTypeForName(f.name) === null) refuse(`file "${f.name}" is not a name a template may carry`);
    if (!Number.isSafeInteger(f.bytes) || f.bytes < 0 || f.bytes > cap!.cap) refuse(`file "${f.name}" is over its cap (${cap!.label})`);
    total += f.bytes;
  }
  if (total > CAPS.total) refuse("template is over 24 MB in total");
  if (!names.has("template.json") || !names.has("index.md")) refuse("template is missing template.json or index.md");
}

/** The listing's text, held to the site's rules: what names the installed row. */
function listingMetadata(t: CloudTemplate): { name: string; description: string; tags: string[] } {
  const name = t.name.trim();
  const description = t.description.trim();
  const nameProblem =
    !name || name.length > TEMPLATE_LIMITS.nameChars
      ? "must be 1-80 characters"
      : (singleLineTextProblem(name) ??
        (visibleCharCount(name) < MIN_VISIBLE_NAME_CHARS ? `needs at least ${MIN_VISIBLE_NAME_CHARS} visible characters` : edgeTextProblem(name)));
  if (nameProblem) refuse(`the listing's name ${nameProblem}`);
  const descriptionProblem = description.length > TEMPLATE_LIMITS.descriptionChars ? "is over 500 characters" : (multiLineTextProblem(description) ?? (description ? edgeTextProblem(description) : null));
  if (descriptionProblem) refuse(`the listing's description ${descriptionProblem}`);
  const tags = normalizeTags(t.tags);
  const tagProblem = tagsError(tags);
  if (tagProblem) refuse(`the listing's ${tagProblem}`);
  return { name, description, tags };
}

/**
 * The scaffold agrees with what the catalog says about it — and with the
 * cached index entry, when there is one. A document OLDER than the index
 * lists is a rollback (a stale or tampered answer): refused. A newer one only
 * means the index has not refreshed since.
 */
function checkAgreement(cloudId: string, t: CloudTemplate, scaffold: TemplateScaffold): void {
  const hasCode = hasCodeIn(scaffold);
  if (hasCode !== t.hasCode) refuse("template.json does not match the catalog (code)");
  if (scaffold.slots.length !== t.slotCount) refuse("template.json does not match the catalog (slot count)");
  if (scaffold.canvas.width !== t.canvas.width || scaffold.canvas.height !== t.canvas.height) refuse("template.json does not match the catalog (canvas)");
  if (Math.abs(scaffold.duration - t.duration) > 1e-6) refuse("template.json does not match the catalog (duration)");
  const entry = getCatalogEntry(cloudId);
  if (!entry) return;
  if (entry.version > t.version) refuse(`the catalog offered version ${t.version}, older than the ${entry.version} its index lists`);
  if (entry.version === t.version) {
    const same =
      entry.hasCode === t.hasCode &&
      entry.slotCount === t.slotCount &&
      entry.canvasWidth === t.canvas.width &&
      entry.canvasHeight === t.canvas.height &&
      entry.authorId === t.authorId;
    if (!same) refuse("template.json does not match the catalog's index entry");
  }
}

/**
 * Why one scaffold asset can't be part of a public template, or null — the
 * install's rule, shared with a public template's page (`fetchCatalogScaffold`)
 * and the page's media stream (lib/templates/cloud/asset-stream.ts, which
 * re-checks the url on every hop): images and fonts may be files (the site's
 * rule — video and audio travel as https urls), a url must name a public host,
 * and a file must be one the catalog lists for this version (`listed`).
 * Assets are named by position, never by `ref`: a ref is the author's word,
 * and this reason reaches the agent as `install_failed.reason`.
 */
export function catalogAssetProblem(a: TemplateScaffold["assets"][number], index: number, listed: ReadonlySet<string>): string | null {
  const which = `asset #${index + 1}`;
  if (a.url !== undefined) {
    const problem = hostedUrlProblem(a.url);
    return problem ? `${which} url ${problem}` : null;
  }
  const file = a.file ?? "";
  const media = (a.kind === "image" && IMAGE_EXT.test(file)) || (a.kind === "font" && FONT_EXT.test(file));
  if (!media) return `${which} (${file}) is not a ${a.kind} file a template may carry - the template is broken`;
  if (!listed.has(file)) return `${which} names ${file}, which was not in the download`;
  return null;
}

/**
 * The scaffold names only what the download holds, and every file it names
 * is media of its declared kind (`catalogAssetProblem`). Anything else is a
 * broken template.
 */
function checkAssets(scaffold: TemplateScaffold, files: Map<string, Buffer>): void {
  const named = new Set<string>(["template.json", "index.md", "poster.jpg", "example.mp4"]);
  const listed = new Set(files.keys());
  for (const [i, a] of scaffold.assets.entries()) {
    const problem = catalogAssetProblem(a, i, listed);
    if (problem) refuse(problem);
    if (a.file !== undefined) named.add(a.file);
  }
  for (const o of scaffold.overlays) if (o.codeFile) named.add(o.codeFile);
  for (const name of files.keys()) if (!named.has(name)) refuse(`file "${name}" is not part of the template`);
  for (const o of scaffold.overlays) if (o.codeFile && !files.has(o.codeFile)) refuse(`${o.codeFile} was not in the download`);
}

/** Code overlays: refused while code templates are off; when on, every body passes the add_overlay validators first. */
function checkCode(scaffold: TemplateScaffold, t: CloudTemplate, files: Map<string, Buffer>): void {
  if (!hasCodeIn(scaffold) && !t.hasCode) return;
  if (!PUBLIC_CODE_TEMPLATES) refuse(`${CODE_TEMPLATES_INSTALL_BLOCKED}: this template runs code, and libi can't sandbox a stranger's code yet`, "code_blocked");
  for (const o of scaffold.overlays) {
    if (!o.codeFile) continue;
    const body = files.get(o.codeFile)!.toString("utf8");
    const verdict = o.kind === "three" ? validateThreeFunction(body) : validateDrawFunction(body);
    if (!verdict.valid) refuse(`${o.codeFile} was rejected: ${verdict.error}`);
  }
}

function parseScaffold(files: Map<string, Buffer>): TemplateScaffold {
  const scaffold = scaffoldFromJson(files.get("template.json")!);
  const instructions = files.get("index.md")!.toString("utf8");
  const mdProblem = multiLineTextProblem(instructions);
  if (mdProblem) refuse(`index.md ${mdProblem}`);
  return scaffold;
}

/** template.json's bytes as a validated scaffold, held to the site's text rules — or a refusal. */
function scaffoldFromJson(buf: Buffer): TemplateScaffold {
  let raw: unknown;
  try {
    raw = JSON.parse(buf.toString("utf8"));
  } catch {
    return refuse("template.json is not JSON");
  }
  // The reasons quote no value from the template: they reach the agent (and
  // the page) as libi's words, not the author's.
  const v = validateScaffold(raw);
  if (!v.ok) refuse(`scaffold is invalid: ${reasonWithoutTemplateText(v.reason)}`);
  const scaffold = (v as { ok: true; scaffold: TemplateScaffold }).scaffold;
  // The site's text rules on every string (slot labels and hints included) and every key.
  const problems = scaffoldValueProblems(scaffold, { blankTemplateKeys: true });
  if (problems.length > 0) refuse(`scaffold is invalid: ${reasonWithoutTemplateText(problems[0])}`);
  return scaffold;
}

/** A public template's scaffold for its page: only the assets that pass the install's check, and how many did not. */
export interface CatalogScaffold {
  scaffold: TemplateScaffold;
  /** Assets left out because the install would refuse them (`catalogAssetProblem`): never rendered, never streamed. */
  droppedAssets: number;
}

/**
 * A public template's scaffold, read WITHOUT installing it — for its page in
 * libi. Only `template.json` is downloaded, through the install's own path:
 * the same folder check on the document, the manifest's cap, declared size
 * and md5 for the file, the bucket-only guard on every hop, the text checks
 * on the bytes, the scaffold validator and the site's text rules, and the
 * agreement with the catalog's document and cached index entry. Nothing is
 * written to disk. Throws the install's refusal (an `Error` whose `code` is
 * an `InstallErrorCode`: `download_failed` when the file could not be
 * fetched, `rejected` when its content was refused).
 *
 * Each asset is held to the install's own asset check (`catalogAssetProblem`,
 * against the files the catalog lists for this version). Where the install
 * would refuse the whole template, the page drops that asset and counts it
 * (D5–D6 review I3): a link to a private host, or a video file the site
 * would never serve, is not offered as a link or a player.
 */
export async function fetchCatalogScaffold(t: CloudTemplate, signal?: AbortSignal): Promise<CatalogScaffold> {
  const base = catalogBucketBaseFor();
  const prefix = `templates/${t.id}/v${t.version}/`;
  if (!CLOUD_ID_PATTERN.test(t.id) || t.base !== base || t.prefix !== prefix || !Number.isSafeInteger(t.version) || t.version < 1) {
    refuse("the catalog answered with a template outside its folder");
  }
  const entry = t.files.find((f) => f.name === "template.json");
  if (!entry) return refuse("template is missing template.json or index.md");
  const cap = capForName(entry.name);
  if (!cap || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0 || entry.bytes > cap.cap) refuse(`file "${entry.name}" is over its cap (${cap?.label ?? "unknown"})`);
  const folderUrl = base + prefix;
  let buf: Buffer;
  try {
    buf = await download(folderUrl, bucketOnlyGuard(folderUrl), entry, signal ?? AbortSignal.timeout(FILE_TIMEOUT_MS));
  } catch (err) {
    if (err instanceof InstallRefusal) throw err;
    return refuse(`file "template.json" could not be downloaded (${printable(err instanceof Error ? err.message : String(err))})`, "download_failed");
  }
  const problem = contentProblem(entry.name, buf);
  if (problem) refuse(problem);
  const scaffold = scaffoldFromJson(buf);
  checkAgreement(t.id, t, scaffold);
  const listed = new Set(t.files.map((f) => f.name));
  const assets = scaffold.assets.filter((a, i) => catalogAssetProblem(a, i, listed) === null);
  return { scaffold: { ...scaffold, assets }, droppedAssets: scaffold.assets.length - assets.length };
}

// ---------------------------------------------------------------------------
// The install
// ---------------------------------------------------------------------------

/**
 * The row a cloudId already has here: an installed copy first, else the
 * author's own published one — from THIS catalog only (`linkedToThisCatalog`):
 * a row installed from or published to another is not a copy of this one's.
 */
function existingRow(cloudId: string): TemplateRow | null {
  const db = getDb();
  const here = and(eq(templates.cloudId, cloudId), linkedToThisCatalog());
  const installed = db.select().from(templates).where(and(here, eq(templates.origin, "installed"))).orderBy(desc(templates.updatedAt)).limit(1).all()[0];
  if (installed) return installed;
  return db.select().from(templates).where(here).limit(1).all()[0] ?? null;
}

/** Write each file into a fresh staging folder: exclusive create, never through a planted symlink. */
async function stage(files: Map<string, Buffer>): Promise<string> {
  await fs.mkdir(templatesRoot(), { recursive: true });
  const dir = await fs.mkdtemp(path.join(templatesRoot(), ".install-"));
  try {
    for (const [name, buf] of files) await writeStagedFile(dir, name, buf);
  } catch (err) {
    await fs.rm(dir, { recursive: true, force: true });
    throw err;
  }
  return dir;
}

/**
 * Write `buf` at `name` under `dir`: a relative name that stays inside `dir`,
 * created exclusively (`O_EXCL`), never followed through a symlink
 * (`O_NOFOLLOW` where the platform has it). A planted file, symlink or hard
 * link at that path makes the write fail rather than land somewhere else.
 */
export async function writeStagedFile(dir: string, name: string, buf: Buffer): Promise<void> {
  const target = path.resolve(dir, ...name.split("/"));
  if (name.split("/").includes("..") || !target.startsWith(dir + path.sep)) throw new Error(`refusing to write outside the staging folder: ${printable(name)}`);
  await fs.mkdir(path.dirname(target), { recursive: true });
  const flags = fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW ?? 0);
  const handle = await fs.open(target, flags, 0o644);
  try {
    await handle.writeFile(buf);
  } finally {
    await handle.close();
  }
}

async function install(cloudId: string, opts: InstallOptions): Promise<InstallResult> {
  const force = opts.force === true;
  if (!CLOUD_ID_PATTERN.test(cloudId)) return { ok: false, error: "not a catalog template id", code: "invalid_id" };
  const before = existingRow(cloudId);
  // The author's own published template: theirs already, nothing to download.
  if (before && before.origin === "local") return { ok: true, templateId: before.id, version: before.version, reinstalled: false };
  if (before && opts.version !== undefined && before.version === opts.version && !force) {
    return { ok: true, templateId: before.id, version: before.version, reinstalled: false };
  }

  const fetched = await getCloudTemplate(cloudId);
  if (!fetched.ok) {
    if (isNoSuchTemplate(fetched)) return { ok: false, error: "This template is no longer in the catalog (removed or hidden).", code: "not_found" };
    // Offline, or a catalog answer that could not be read: an installed copy still works.
    if (before) {
      logger.info({ tag: TAG, op: "install_offline_installed_copy", cloudId, templateId: before.id }, "catalog unreachable; using the installed copy");
      return { ok: true, templateId: before.id, version: before.version, reinstalled: false };
    }
    // No status: the request never got an answer (offline, DNS, a timeout).
    const code: InstallErrorCode = fetched.code === "rate_limited" ? "rate_limited" : fetched.status === undefined ? "unreachable" : "catalog_error";
    return { ok: false, error: printable(fetched.error), code };
  }
  const t = fetched.template;

  // The client checked these too; this layer does not rely on it.
  const base = catalogBucketBaseFor();
  const prefix = `templates/${cloudId}/v${t.version}/`;
  if (t.id !== cloudId || t.base !== base || t.prefix !== prefix || !Number.isSafeInteger(t.version) || t.version < 1) {
    return { ok: false, error: "the catalog answered with a template outside its folder", code: "rejected" };
  }
  if (opts.version !== undefined && t.version !== opts.version) {
    return {
      ok: false,
      error: `the catalog now has version ${t.version} of this template, not the ${opts.version} asked for - reload the list and try again`,
      code: "version_changed",
    };
  }
  if (before && before.version > t.version) {
    return { ok: false, error: `the catalog offered version ${t.version}, older than the installed ${before.version} - not installed`, code: "older_version" };
  }
  if (before && before.version === t.version && !force) return { ok: true, templateId: before.id, version: t.version, reinstalled: false };

  const metadata = listingMetadata(t);
  checkManifest(t);

  const folderUrl = base + prefix;
  const guard = bucketOnlyGuard(folderUrl);
  const signal = opts.signal ? AbortSignal.any([opts.signal, AbortSignal.timeout(INSTALL_TIMEOUT_MS)]) : AbortSignal.timeout(INSTALL_TIMEOUT_MS);
  const files = new Map<string, Buffer>();
  const totalBytes = t.files.reduce((n, f) => n + f.bytes, 0);
  let doneBytes = 0;
  for (const f of t.files) {
    if (opts.signal?.aborted) refuse(STOPPED, "stopped");
    try {
      files.set(f.name, await download(folderUrl, guard, f, signal));
    } catch (err) {
      if (err instanceof InstallRefusal) throw err;
      if (opts.signal?.aborted) refuse(STOPPED, "stopped");
      refuse(`file "${f.name}" could not be downloaded (${err instanceof Error ? err.message : String(err)})`, "download_failed");
    }
    doneBytes += f.bytes;
    await opts.onFile?.({ name: f.name, index: files.size, count: t.files.length, doneBytes, totalBytes });
  }
  if (opts.signal?.aborted) refuse(STOPPED, "stopped");
  for (const [name, buf] of files) {
    const problem = contentProblem(name, buf);
    if (problem) refuse(problem);
  }

  const scaffold = parseScaffold(files);
  checkAgreement(cloudId, t, scaffold);
  checkAssets(scaffold, files);
  checkCode(scaffold, t, files);

  // Looked up again: another install of the same template may have landed while this one downloaded.
  const current = existingRow(cloudId);
  if (current && current.origin === "local") return { ok: true, templateId: current.id, version: current.version, reinstalled: false };
  if (current && current.version > t.version) {
    return { ok: false, error: `version ${current.version} was installed meanwhile - not replaced by ${t.version}`, code: "older_version" };
  }

  const staging = await stage(files);
  let row: TemplateRow;
  try {
    row = await importTemplateFolder(staging, {
      origin: "installed",
      cloudId,
      version: t.version,
      metadata,
      ...(current ? { replaceId: current.id } : {}),
    });
  } catch (err) {
    // The UNIQUE index on templates.cloud_id: another install of this template
    // (another process) inserted its row first. The store already removed this
    // call's folder; the row that won is the answer.
    if (!current && isCloudIdTaken(err)) {
      const winner = existingRow(cloudId);
      if (winner) {
        logger.info({ tag: TAG, op: "install_lost_race", cloudId, templateId: winner.id }, "another install of this template landed first; using its row");
        return { ok: true, templateId: winner.id, version: winner.version, reinstalled: false };
      }
    }
    throw err;
  } finally {
    await fs.rm(staging, { recursive: true, force: true });
  }
  trackServerEvent("template_installed");
  logger.info(
    { tag: TAG, op: "installed", cloudId, version: t.version, templateId: row.id, reinstalled: current !== null, files: files.size },
    "public template installed",
  );
  return { ok: true, templateId: row.id, version: t.version, reinstalled: current !== null };
}

/** One install per cloud id at a time in this process, with the version it was asked for. */
const inFlight = new Map<string, { version: number | undefined; result: Promise<InstallResult> }>();

/**
 * Install (or update) the public template `cloudId`. Same version already
 * installed: a no-op (`force` downloads it again). Newer: re-installed over the
 * same row, so its id stays stable. Older: refused. Offline with a copy
 * installed: that copy. Never throws.
 *
 * One install per cloud id runs at a time here, whatever its options. A plain
 * call asking for the same version joins the running one. Any other call waits
 * for it to finish, then runs its own: a `force` call (a forced re-download is
 * a decision about the bytes on disk, which only exist once the running
 * install is done), and a call asking for another version (its own version
 * check must run — the owner's answer is to a different question). A joined
 * call gets no `onFile` ticks — the running install's owner does — and never
 * inherits the owner's stop: if the owner was stopped and this call was not,
 * it runs its own install.
 */
export function installTemplate(cloudId: string, opts: InstallOptions = {}): Promise<InstallResult> {
  const running = inFlight.get(cloudId);
  if (running && opts.force !== true && running.version === opts.version) {
    return running.result.then((r) => (!r.ok && r.code === "stopped" && !opts.signal?.aborted ? installTemplate(cloudId, opts) : r));
  }
  const p: Promise<InstallResult> = (running ? running.result.then(() => install(cloudId, opts)) : install(cloudId, opts))
    .catch((err: unknown): InstallResult => {
      const error = printable(err instanceof Error ? err.message : String(err));
      if (err instanceof InstallRefusal) {
        logger.warn({ tag: TAG, op: "install_refused", cloudId, error }, "public template refused");
        return { ok: false, error, code: err.code };
      }
      logger.error({ tag: TAG, op: "install_failed", cloudId, error }, "public template install failed");
      return { ok: false, error: `the template could not be installed (${error})`, code: "failed" };
    })
    .finally(() => {
      if (inFlight.get(cloudId)?.result === p) inFlight.delete(cloudId);
    });
  inFlight.set(cloudId, { version: opts.version, result: p });
  return p;
}
