/**
 * The publish preflight: every rule libi-site applies to a publish, run here
 * first, so the agent hears every refusal at once and before a single byte is
 * uploaded — not one 400 per round-trip after a minute of transcoding.
 *
 * Each rule mirrors a site file, named beside it:
 *  - `lib/templates/prepare.ts#parsePrepare` — metadata, scaffold, files, example;
 *  - `lib/templates/text-rules.ts` — the character rules, through the verbatim
 *    copy in `./text-rules`;
 *  - `lib/templates/verify.ts#sniffObject` — what commit checks in a text file's
 *    bytes (code files meet no other rule);
 *  - `lib/templates/constants.ts` — caps and patterns, through `./constants`.
 * Messages are the site's own words. Unlike `parsePrepare`, nothing here stops
 * at the first problem: the result lists them all. The parity test
 * (`__tests__/unit/templates/cloud/preflight.test.ts`) runs the site's own
 * accepted/refused table through this module.
 *
 * The site stays the authority: passing here is no promise it will accept.
 */
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import {
  ASSET_BASENAME_PATTERN,
  CAPS,
  EXAMPLE_MAX_LONG_EDGE,
  EXAMPLE_MAX_SECONDS,
  EXAMPLE_MIN_SECONDS,
  FONT_EXTS,
  IMAGE_EXTS,
  MAX_DESCRIPTION,
  MAX_FILES,
  MAX_NAME,
  MAX_TAGS,
  PUBLIC_CODE_TEMPLATES,
  PUBLISH_BODY_CAP,
  TAG_PATTERN,
} from "@/lib/templates/cloud/constants";
import {
  MIN_VISIBLE_NAME_CHARS,
  TAG_MESSAGE,
  edgeTextProblem,
  hasStrayTagCharacter,
  multiLineTextProblem,
  singleLineTextProblem,
  visibleCharCount,
} from "@/lib/templates/cloud/text-rules";
import { pathWithoutTemplateKeys, validateScaffold, type TemplateScaffold } from "@/lib/templates/scaffold";
import { SCAFFOLD_SCHEMA_SHA256 } from "@/lib/templates/scaffold-schema";

/** Mirrors prepare.ts#CODE_TEMPLATES_BLOCKED_ERROR. */
export const CODE_TEMPLATES_BLOCKED_ERROR = "Templates with code can't be published yet";
export const EXAMPLE_REQUIRED_ERROR =
  "An example video is required to publish — pass exampleVideo: { fileId } | { path } | { exportPieceId }.";

// --- names and content types (prepare.ts) ------------------------------------

// Maps, not object literals: a name like "constructor" must not resolve through Object.prototype.
const FIXED: ReadonlyMap<string, string> = new Map([
  ["template.json", "application/json"],
  ["index.md", "text/markdown"],
  ["poster.jpg", "image/jpeg"],
  ["example.mp4", "video/mp4"],
]);
const TYPE_BY_EXT: ReadonlyMap<string, string> = new Map([
  ["jpg", "image/jpeg"],
  ["jpeg", "image/jpeg"],
  ["png", "image/png"],
  ["webp", "image/webp"],
  ["svg", "image/svg+xml"],
  ["ttf", "font/ttf"],
  ["otf", "font/otf"],
  ["woff2", "font/woff2"],
]);
const CODE_CONTENT_TYPE = "text/plain; charset=utf-8";
/** Only the two code files a scaffold can declare — `content.jsx` is not a catalog name. */
const CODE_NAME = /^overlays\/([a-z][a-z0-9-]{0,39})\/(draw|scene)\.jsx$/;
const ASSET_PREFIX = "assets/";
const MD5_PATTERN = /^[A-Za-z0-9+/]{22}==$/;
/** verify.ts#TEXT_NAME: the files commit reads whole and holds to the text checks. */
const TEXT_NAME = /^(template\.json|index\.md|overlays\/[^/]+\/(draw|scene)\.jsx)$/;

/** The extension of a well-formed `assets/<basename>`, or null. Mirrors prepare.ts#assetExtension. */
function assetExtension(name: string): string | null {
  if (!name.startsWith(ASSET_PREFIX)) return null;
  const basename = name.slice(ASSET_PREFIX.length);
  if (!ASSET_BASENAME_PATTERN.test(basename) || basename.includes("..")) return null;
  const dot = basename.lastIndexOf(".");
  return dot > 0 ? basename.slice(dot + 1) : null;
}
function isImageExt(ext: string): boolean {
  return (IMAGE_EXTS as readonly string[]).includes(ext);
}
function isFontExt(ext: string): boolean {
  return (FONT_EXTS as readonly string[]).includes(ext);
}

/** The pinned content type for a file name, or null when the catalog admits no such name. Mirrors prepare.ts#contentTypeFor. */
export function contentTypeForName(name: string): string | null {
  if (typeof name !== "string") return null;
  const fixed = FIXED.get(name);
  if (fixed) return fixed;
  if (CODE_NAME.test(name)) return CODE_CONTENT_TYPE;
  const ext = assetExtension(name);
  return ext === null ? null : (TYPE_BY_EXT.get(ext) ?? null);
}

/** The byte cap for an allowed name, with the label its refusal quotes. Mirrors prepare.ts#capFor. */
export function capForName(name: string): { cap: number; label: string } | null {
  if (name === "template.json") return { cap: CAPS.scaffold, label: "template.json ≤ 256 KB" };
  if (name === "index.md") return { cap: CAPS.instructions, label: "index.md ≤ 32 KB" };
  if (name === "poster.jpg") return { cap: CAPS.poster, label: "poster.jpg ≤ 400 KB" };
  if (name === "example.mp4") return { cap: CAPS.example, label: "example.mp4 ≤ 8 MB" };
  if (CODE_NAME.test(name)) return { cap: CAPS.code, label: "code file ≤ 128 KB" };
  const ext = assetExtension(name);
  if (ext === null) return null;
  if (isImageExt(ext)) return { cap: CAPS.image, label: "image ≤ 2 MB" };
  if (isFontExt(ext)) return { cap: CAPS.font, label: "font ≤ 4 MB" };
  return null;
}

/** A code or three overlay — the kinds that ship a `.jsx` file. Mirrors prepare.ts#hasCodeIn. */
export function hasCodeIn(scaffold: TemplateScaffold): boolean {
  return scaffold.overlays.some((o) => o.kind === "code" || o.kind === "three" || o.codeFile !== undefined);
}

// --- message text (prepare.ts) -------------------------------------------------

function clip(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}...` : s;
}
function unicodeEscape(c: string): string {
  return `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`;
}
/** Mirrors prepare.ts#printable: cut to `max`, printable ASCII only, one escaping pass. */
function printable(s: string, max: number): string {
  return clip(s, max).replace(/[^\x20-\x7e]|\\/g, (c) => (c === "\\" ? "\\\\" : unicodeEscape(c)));
}
/** Mirrors prepare.ts#show: a name, quoted and escaped for a message. */
function show(s: string): string {
  return `"${clip(s, 80).replace(/[^\x20-\x7e]|["\\]/g, (c) => (c === '"' || c === "\\" ? `\\${c}` : unicodeEscape(c)))}"`;
}

// --- hosted urls (prepare.ts#hostedUrlProblem, verbatim) ------------------------

/**
 * Why a hosted asset url is refused, or null. Every installing app fetches
 * these urls, so beyond "https" the host must be a public name: no
 * credentials, no IP literal (after the URL parser's normalisation), no
 * `localhost` / `.local` / `.internal` / `.localhost`, no single-label host
 * and no empty label; the raw text printable ASCII with no spaces.
 */
export function hostedUrlProblem(raw: string): string | null {
  if (!/^[\x21-\x7e]+$/.test(raw)) return "must be printable ASCII with no spaces";
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "must be an https url";
  }
  if (url.protocol !== "https:") return "must be an https url";
  if (url.username !== "" || url.password !== "") return "may not carry credentials";
  if (url.hostname.startsWith(".") || url.hostname.includes("..")) return "must name a public host";
  const host = url.hostname.toLowerCase().replace(/\.+$/, "");
  if (host.startsWith("[") || /^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return "must name a host, not an IP address";
  if (!host.includes(".") || host === "localhost" || /\.(localhost|local|internal)$/.test(host)) return "must name a public host";
  return null;
}

// --- every value in the scaffold (prepare.ts#scaffoldValueProblem) --------------

const SINGLE_LINE_FIELDS: ReadonlySet<string> = new Set(["name", "slots.*.label", "overlays.*.displayName", "overlays.*.group", "audioClips.*.label", "fonts.*.family"]);
/** The walk reports this many problems, then says there are more. */
const MAX_VALUE_PROBLEMS = 10;

type WalkNode = { value: unknown; key: string | number | null; parent: WalkNode | null; depth: number };

function pathOf(node: WalkNode): Array<string | number> {
  const out: Array<string | number> = [];
  for (let n: WalkNode | null = node; n !== null && n.key !== null; n = n.parent) out.push(n.key);
  return out.reverse();
}
function fieldPattern(p: Array<string | number>): string {
  return p.map((x) => (typeof x === "number" ? "*" : x)).join(".");
}

/**
 * Every string or object key in the (schema-parsed) scaffold that breaks the
 * text rules, and every number that is not finite — the site stops at the
 * first, this collects them (up to a bound). Iterative: `keyframes` is
 * free-form and may nest deeper than the stack.
 */
export function scaffoldValueProblems(scaffold: TemplateScaffold, opts: { blankTemplateKeys?: boolean } = {}): string[] {
  const out: string[] = [];
  let more = 0;
  const report = (m: string) => (out.length < MAX_VALUE_PROBLEMS ? out.push(m) : (more += 1));
  // A stranger's template (the install): a key the author chose, such as an
  // effect param's name, is not quoted back in the location.
  const where = (node: WalkNode) => printable(opts.blankTemplateKeys ? pathWithoutTemplateKeys(pathOf(node)) : pathOf(node).join("."), 120);
  const stack: WalkNode[] = [{ value: scaffold, key: null, parent: null, depth: 0 }];
  while (stack.length > 0) {
    const node = stack.pop()!;
    const { value } = node;
    if (typeof value === "string") {
      const singleLine = node.depth <= 3 && SINGLE_LINE_FIELDS.has(fieldPattern(pathOf(node)));
      const problem = singleLine ? singleLineTextProblem(value) : multiLineTextProblem(value);
      if (problem) report(`scaffold at ${where(node)} ${problem}.`);
    } else if (typeof value === "number") {
      if (!Number.isFinite(value)) report(`scaffold at ${where(node)} must be a finite number.`);
    } else if (Array.isArray(value)) {
      for (let i = value.length - 1; i >= 0; i--) stack.push({ value: value[i], key: i, parent: node, depth: node.depth + 1 });
    } else if (typeof value === "object" && value !== null) {
      const entries = Object.entries(value);
      for (const [k] of entries) {
        const problem = singleLineTextProblem(k);
        if (problem) report(`scaffold at ${where(node) || "top level"}: a key ${problem}.`);
      }
      for (let i = entries.length - 1; i >= 0; i--) stack.push({ value: entries[i][1], key: entries[i][0], parent: node, depth: node.depth + 1 });
    }
  }
  if (more > 0) out.push(`...and ${more} more problem(s) in the scaffold.`);
  return out;
}

// --- tags (prepare.ts#parseTags) -------------------------------------------------

/** ASCII-only lowercasing: `toLowerCase` folds U+212A KELVIN SIGN to "k". */
function normaliseTag(t: string): string {
  return t.trim().replace(/[A-Z]+/g, (m) => m.toLowerCase());
}
function parseTags(raw: unknown): string[] | string {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) return "tags must be an array.";
  if (raw.length > MAX_TAGS) return `tags: at most ${MAX_TAGS}.`;
  const out: string[] = [];
  for (const t of raw) {
    if (typeof t !== "string") return "tags must be strings.";
    const tag = normaliseTag(t);
    if (!TAG_PATTERN.test(tag)) return `tag ${show(t)} must match ^[a-z0-9][a-z0-9-]{0,29}$.`;
    out.push(tag);
  }
  return [...new Set(out)];
}
function sameSet(a: readonly string[], b: readonly string[]): boolean {
  const sa = new Set(a);
  const sb = new Set(b);
  return sa.size === sb.size && [...sa].every((x) => sb.has(x));
}

// --- a text file's bytes (verify.ts#sniffObject, text branch) --------------------

/** Why the bytes of a text file (template.json, index.md, a code file) would fail commit's sniff, or null. */
export function textFileProblem(name: string, body: Buffer): string | null {
  if (body.includes(0)) return `${name} contains a NUL byte`;
  let text: string;
  try {
    // ignoreBOM keeps a leading BOM in the text, as the site's decoder does.
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(body);
  } catch {
    return `${name} is not valid UTF-8`;
  }
  return hasStrayTagCharacter(text) ? `${name} ${TAG_MESSAGE}` : null;
}

// --- the request body (http.ts#readJsonBody with PREPARE_BODY_CAP) ---------------

/**
 * A publish request exactly as the client sends it to prepare and commit:
 * the body, then this build's schemaHash, stamped last so no caller can send
 * a stale one. The client serialises through this, so what the preflight
 * measures is what goes on the wire.
 */
export function publishRequestJson(body: Record<string, unknown>): string {
  return JSON.stringify({ ...body, schemaHash: SCAFFOLD_SCHEMA_SHA256 });
}

/** The UTF-8 byte length of `publishRequestJson(body)` — what the site's body cap counts. */
export function publishRequestBytes(body: Record<string, unknown>): number {
  return Buffer.byteLength(publishRequestJson(body), "utf8");
}

// --- the preflight ---------------------------------------------------------------

export interface PreflightFile {
  name: string;
  bytes: number;
  /** When given, must be the pinned type (as the site requires); the manifest always gives it. */
  contentType?: string;
  /** When given, must be a base64 md5; the manifest always gives it. */
  md5?: string;
  /** A text file's bytes, sniffed the way commit will (NUL, UTF-8, TAG characters). */
  content?: Buffer;
}

export interface ExampleMeta {
  durationSec: number;
  width: number;
  height: number;
}

export interface PreflightInput {
  /** Exactly what will be sent as the publish body's metadata. */
  name: string;
  description: string;
  tags: readonly string[];
  /** The scaffold that will be sent, and uploaded as template.json. */
  scaffold: unknown;
  /** The index.md text that will be sent, and uploaded. */
  instructions: string;
  files: readonly PreflightFile[];
  /** The example as it was read back; null when there is none. */
  example: ExampleMeta | null;
  /**
   * The example and poster are still to be made: skip the checks only they can
   * satisfy, so everything else is refused before an export or a transcode.
   */
  mediaPending?: boolean;
  /**
   * The byte length of the largest request this publish sends — commit's, the
   * body plus templateId and version — as `publishRequestBytes` measures it.
   * Before the media is made, an upper bound. Omitted: not checked.
   */
  bodyBytes?: number;
}

export type PreflightResult = { ok: true } | { ok: false; reasons: string[] };

function isExampleMeta(v: object): v is ExampleMeta {
  const r = v as Record<string, unknown>;
  return typeof r.durationSec === "number" && typeof r.width === "number" && typeof r.height === "number";
}

/** Every reason the site would refuse this publish, gathered locally, in its own words. */
export function preflightPublish(input: PreflightInput): PreflightResult {
  const reasons: string[] = [];
  const fail = (m: string) => reasons.push(m);

  // --- metadata (prepare.ts, "metadata") ---
  const name = typeof input.name === "string" ? input.name.trim() : "";
  let nameOk = false;
  if (!name || name.length > MAX_NAME) fail(`name is required and at most ${MAX_NAME} characters.`);
  else {
    const problem = singleLineTextProblem(name);
    if (problem) fail(`name ${problem}.`);
    else if (visibleCharCount(name) < MIN_VISIBLE_NAME_CHARS) fail(`name needs at least ${MIN_VISIBLE_NAME_CHARS} visible characters (letters or digits).`);
    else {
      const edge = edgeTextProblem(name);
      if (edge) fail(`name ${edge}.`);
      else nameOk = true;
    }
  }
  let descriptionOk = false;
  const description = typeof input.description === "string" ? input.description.trim() : "";
  if (input.description !== undefined && typeof input.description !== "string") fail("description must be a string.");
  else if (description.length > MAX_DESCRIPTION) fail(`description is at most ${MAX_DESCRIPTION} characters.`);
  else {
    const problem = multiLineTextProblem(description) ?? edgeTextProblem(description);
    if (problem) fail(`description ${problem}.`);
    else descriptionOk = true;
  }
  const tags = parseTags(input.tags);
  if (typeof tags === "string") fail(tags);

  // --- the scaffold ---
  let scaffold: TemplateScaffold | null = null;
  const v = validateScaffold(input.scaffold);
  if (!v.ok) fail(`scaffold is invalid: ${printable(v.reason, 240)}`);
  else {
    scaffold = v.scaffold;
    reasons.push(...scaffoldValueProblems(scaffold));
    // The listing shows the body's metadata, the install the scaffold's: one thing, character for character.
    if (nameOk && scaffold.name !== name) fail("scaffold.name must equal name exactly (trimmed).");
    if (descriptionOk && scaffold.description !== description) fail("scaffold.description must equal description exactly (trimmed).");
    if (typeof tags !== "string" && !sameSet(scaffold.tags.map(normaliseTag), tags)) fail("scaffold.tags must equal tags.");
  }

  // --- instructions ---
  if (typeof input.instructions !== "string") fail("instructions (index.md) must be a string.");
  else if (Buffer.byteLength(input.instructions, "utf8") > CAPS.instructions) fail("index.md is at most 32 KB.");
  else {
    const problem = multiLineTextProblem(input.instructions);
    if (problem) fail(`instructions (index.md) ${problem}.`);
  }

  // --- what the scaffold declares ---
  const declared = new Set<string>();
  if (scaffold) {
    if (hasCodeIn(scaffold) && !PUBLIC_CODE_TEMPLATES) fail(CODE_TEMPLATES_BLOCKED_ERROR);
    for (const asset of scaffold.assets) {
      if ((asset.kind === "video" || asset.kind === "audio") && asset.url === undefined) {
        fail(`asset "${asset.ref}" is ${asset.kind} and must be a hosted url, not a file.`);
      }
      const urlProblem = asset.url === undefined ? null : hostedUrlProblem(asset.url);
      if (urlProblem) fail(`asset "${asset.ref}" url ${urlProblem}.`);
    }
    for (const asset of scaffold.assets) {
      if (asset.file === undefined) continue;
      const ext = assetExtension(asset.file);
      const fitsKind = ext !== null && (asset.kind === "image" ? isImageExt(ext) : asset.kind === "font" && isFontExt(ext));
      if (!fitsKind) {
        // A video/audio asset with no url was refused above as "must be a hosted url"; once is enough.
        const saidAlready = (asset.kind === "video" || asset.kind === "audio") && asset.url === undefined;
        if (!saidAlready) fail(`asset "${asset.ref}" names file ${show(asset.file)}, which is not an allowed name.`);
        continue;
      }
      declared.add(asset.file);
    }
    for (const overlay of scaffold.overlays) {
      if (overlay.codeFile !== undefined) declared.add(overlay.codeFile);
    }
    // A music link carries no bytes; its source link is fetched on the
    // applying user's yes, so it is held to the same rules as a hosted asset.
    for (const m of scaffold.musicLinks ?? []) {
      const problem = m.sourceUrl === undefined ? null : hostedUrlProblem(m.sourceUrl);
      if (problem) fail(`music "${m.ref}" source link ${problem}.`);
    }
  }

  // --- files ---
  if (input.files.length > MAX_FILES) fail(`At most ${MAX_FILES} files.`);
  const seen = new Set<string>();
  let total = 0;
  for (const f of input.files) {
    const ct = contentTypeForName(f.name);
    const cap = capForName(f.name);
    if (!ct || !cap) {
      fail(`file ${show(f.name)} is not an allowed name.`);
      continue;
    }
    if (seen.has(f.name)) {
      fail(`file "${f.name}" may appear only once.`);
      continue;
    }
    seen.add(f.name);
    if (!Number.isSafeInteger(f.bytes) || f.bytes < 0 || Object.is(f.bytes, -0)) {
      fail(`file "${f.name}": bytes must be a non-negative integer.`);
      continue;
    }
    if (f.contentType !== undefined && f.contentType !== ct) fail(`file "${f.name}" must be uploaded as ${ct}.`);
    if (f.md5 !== undefined && !MD5_PATTERN.test(f.md5)) fail(`file "${f.name}": md5 must be the base64 digest.`);
    if (f.bytes > cap.cap) fail(`file "${f.name}" is too large (${cap.label}).`);
    if (f.content !== undefined && TEXT_NAME.test(f.name)) {
      const problem = textFileProblem(f.name, f.content);
      if (problem) fail(`${problem}.`);
    }
    total += f.bytes;
  }
  if (total > CAPS.total) fail("All files together are at most 24 MB.");
  if (input.bodyBytes !== undefined && input.bodyBytes > PUBLISH_BODY_CAP) {
    fail(
      `Request body is too large. The publish request — template.json and index.md together, with the file list — is ${Math.ceil(input.bodyBytes / 1024)} KB; the catalog reads at most ${PUBLISH_BODY_CAP / 1024} KB.`,
    );
  }
  const media = new Set(["example.mp4", "poster.jpg"]);
  for (const required of FIXED.keys()) {
    if (seen.has(required)) continue;
    // Made by the job, or covered by the one "example video is required" reason.
    if (media.has(required) && (input.mediaPending || input.example === null)) continue;
    fail(`file "${required}" is required.`);
  }
  if (scaffold) {
    for (const name of seen) {
      if (!FIXED.has(name) && !declared.has(name)) fail(`file "${name}" is not declared by the scaffold.`);
    }
    for (const d of declared) {
      if (!seen.has(d)) fail(`file "${d}" is declared by the scaffold but missing from files.`);
    }
  }

  // --- the example ---
  if (!input.mediaPending) {
    const ex = input.example as unknown;
    if (ex === null) fail(EXAMPLE_REQUIRED_ERROR);
    else if (
      typeof ex !== "object" ||
      Array.isArray(ex) ||
      !isExampleMeta(ex) ||
      !Number.isFinite(ex.durationSec) ||
      !Number.isSafeInteger(ex.width) ||
      !Number.isSafeInteger(ex.height) ||
      ex.width <= 0 ||
      ex.height <= 0
    ) {
      fail("example needs durationSec, width and height.");
    } else {
      if (ex.durationSec < EXAMPLE_MIN_SECONDS) fail(`example.mp4 is at least ${EXAMPLE_MIN_SECONDS} seconds.`);
      if (ex.durationSec > EXAMPLE_MAX_SECONDS) fail(`example.mp4 is at most ${EXAMPLE_MAX_SECONDS} seconds.`);
      if (Math.max(ex.width, ex.height) > EXAMPLE_MAX_LONG_EDGE) fail(`example.mp4 is at most ${EXAMPLE_MAX_LONG_EDGE} px on the long edge.`);
    }
  }

  return reasons.length ? { ok: false, reasons } : { ok: true };
}

// --- the manifest ------------------------------------------------------------------

export interface ManifestEntry {
  name: string;
  bytes: number;
  contentType: string;
  /** base64 md5 — what GCS reports, and what commit compares. */
  md5: string;
}

/** The manifest entry for bytes held in memory (template.json, index.md). */
export function manifestEntryFor(name: string, body: Buffer): ManifestEntry {
  return { name, bytes: body.byteLength, contentType: contentTypeForName(name) ?? "application/octet-stream", md5: md5Base64(body) };
}

export function md5Base64(body: Buffer): string {
  return createHash("md5").update(body).digest("base64");
}

/** A file's manifest entry, hashed as a stream: a local template may hold files far over any catalog cap. */
export async function manifestEntryForFile(name: string, absPath: string): Promise<ManifestEntry> {
  const hash = createHash("md5");
  await pipeline(createReadStream(absPath), hash);
  const { size } = await fs.stat(absPath);
  return { name, bytes: size, contentType: contentTypeForName(name) ?? "application/octet-stream", md5: hash.digest("base64") };
}

/**
 * The publishable files under a template folder: the four fixed names that
 * exist, and every regular file under `overlays/` and `assets/`. A name the
 * catalog does not admit is listed all the same — the preflight reports it
 * rather than having it silently left out. Symlinks are not regular files
 * and are never followed (readScaffold refuses a declared one). `skip`: fixed
 * names the caller makes itself — never read, never hashed.
 */
export async function manifestFor(dir: string, opts: { skip?: readonly string[] } = {}): Promise<ManifestEntry[]> {
  const names: string[] = [];
  for (const fixed of FIXED.keys()) {
    if (opts.skip?.includes(fixed)) continue;
    const st = await fs.lstat(path.join(dir, fixed)).catch(() => null);
    if (st?.isFile()) names.push(fixed);
  }
  for (const sub of ["overlays", "assets"]) {
    const entries = await fs.readdir(path.join(dir, sub), { withFileTypes: true, recursive: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      // `parentPath` arrived in Node 20.12 / 21.4; before it, the same value was `path`.
      const parent = entry.parentPath ?? (entry as unknown as { path: string }).path;
      names.push(path.relative(dir, path.join(parent, entry.name)).split(path.sep).join("/"));
    }
  }
  const out: ManifestEntry[] = [];
  for (const name of names.sort()) out.push(await manifestEntryForFile(name, path.join(dir, name)));
  return out;
}
