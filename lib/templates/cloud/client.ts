/**
 * Server-side client for libi-site's templates catalog (`/api/templates/**`)
 * and the public bucket. Node process only — never the renderer. Every call
 * returns `{ ok, ... }`; nothing here throws into a caller. In test mode the
 * base is the studio's own fixture routes (app/api/test-mode/templates-catalog).
 *
 * What comes back is written by strangers (names, descriptions, tags,
 * nicknames) and served by a network we do not control, so every response is
 * parsed against a schema that is an allowlist: text held to the site's own
 * character rules (no controls, bidi overrides or stray TAG characters),
 * capped to the site's own limits;
 * relative media paths that must stay inside their template's folder under
 * this environment's pinned bucket base; signed upload URLs that must be https
 * (loopback http in test mode), uncredentialed, and under that same base.
 *
 * Validated is not trusted. The text fields are still the template AUTHOR's
 * words — whatever hands them to an agent must label them the way
 * `get_template` labels `instructions` (`source: "template author (untrusted)"`).
 *
 * The creator key travels only in the `Authorization` header. It is never
 * logged and is scrubbed from every error string this module returns. So is
 * a dev build's Vercel bypass token, which travels only in
 * `x-vercel-protection-bypass` to its development catalog's origin.
 *
 * Which catalog: `catalogSource()` (lib/templates/cloud/catalog-source.ts) —
 * read on every call, or pinned by the caller's `withCatalogSource`.
 */
import { gunzipSync } from "node:zlib";
import { z } from "zod/v3";
import { serverLogger as logger } from "@/lib/logger";
import { readBodyWithCap } from "@/lib/net/fetch-and-store";
import { isTestMode } from "@/lib/test-mode";
import {
  CAPS,
  CLOUD_FILE_NAME_PATTERN,
  CLOUD_ID_PATTERN,
  CREATOR_NOT_APPROVED_MESSAGE,
  CREATOR_REQUEST_CLOSED_MESSAGE,
  CREATOR_STATUSES,
  INDEX_CAP,
  MAX_FILES,
  MODERATED_MESSAGE,
  MODERATION_NOTE_MAX,
  MODERATION_REASONS,
  REPORT_DETAILS_MAX,
  REPORT_REASONS,
  SIGNED_URL_TTL_MS,
  type CreatorStatus,
  type ReportReason,
} from "@/lib/templates/cloud/constants";
import { catalogApiBaseFor, catalogBucketBaseFor, catalogSource } from "@/lib/templates/cloud/catalog-source";
import { bypassHeadersFor, bypassTokenForScrub } from "@/lib/templates/cloud/catalog-setting";
import { CREATOR_KEY_PATTERN } from "@/lib/templates/cloud/identity";
import { publishRequestJson } from "@/lib/templates/cloud/preflight";
import { multiLineTextProblem, singleLineTextProblem } from "@/lib/templates/cloud/text-rules";
import { TEMPLATE_LIMITS, TEMPLATE_TAG_RE } from "@/lib/templates/scaffold-schema";

/**
 * The site's machine-readable refusal reasons — libi-site
 * lib/templates/publish.ts#PUBLISH_ERROR_CODES, copied (S9, plus S10's
 * route-level `unauthorized` and `rate_limited`, plus S12's `moderated` and
 * `gone` from PATCH /api/templates/<id>, plus S13's `contended` from the use
 * and report routes: a transaction gave up under concurrent writes, nothing
 * was recorded, retry after its `Retry-After`; plus the final review's
 * `publishing_paused` (503, the operator's kill switch: prepare and commit
 * refuse everything, nothing was recorded) and `caps_global` (429, the
 * catalog-wide daily cap on new templates or prepares: try the next UTC
 * day), plus creator approval's `creator_not_approved` (403: publishing is
 * invite-only and this key is not approved — prepare, commit and listing
 * edits) and `creator_request_closed` (409: an application already decided)),
 * in the site's order. The site may reword `error` at will; these never
 * change meaning.
 */
export const PUBLISH_ERROR_CODES = [
  "busy",
  "nothing_pending",
  "wrong_version",
  "replay_mismatch",
  "upload_changed",
  "body_mismatch",
  "expired",
  "not_found",
  "forbidden",
  "moderated",
  "gone",
  "nickname_required",
  "creator_not_approved",
  "creator_request_closed",
  "schema_unsupported",
  "code_templates_disabled",
  "publishing_paused",
  "caps_daily",
  "caps_total",
  "caps_global",
  "unauthorized",
  "rate_limited",
  "contended",
  "invalid",
  "internal",
] as const;
export type PublishErrorCode = (typeof PUBLISH_ERROR_CODES)[number];

function isPublishErrorCode(v: unknown): v is PublishErrorCode {
  return typeof v === "string" && (PUBLISH_ERROR_CODES as readonly string[]).includes(v);
}

/**
 * `code` is the site's reason, when it sent one of its own: switch on it,
 * never on `error` — that is for people, and is never matched.
 */
export type CloudFail = { ok: false; error: string; status?: number; code?: PublishErrorCode; retryAfterMs?: number };

/**
 * A refusal's `Retry-After` in ms: delta-seconds (digits only) or an HTTP
 * date (0 once it has passed). Anything else is no answer at all — a caller
 * falls back to its own backoff.
 */
function retryAfterMs(res: Response): number | undefined {
  const raw = res.headers.get("retry-after")?.trim();
  if (!raw) return undefined;
  if (/^\d{1,9}$/.test(raw)) return Number(raw) * 1000;
  if (!/[a-z]/i.test(raw)) return undefined;
  const at = Date.parse(raw);
  return Number.isNaN(at) ? undefined : Math.max(0, at - Date.now());
}

/**
 * Why an index fetch failed, as a fixed code. `error` beside it is for the
 * log: it can carry the site's own words (a base URL, a status body) or the
 * network stack's, and neither may reach an agent.
 */
export type IndexFailReason = "unreachable" | "http_error" | "invalid_index";
export type IndexFail = CloudFail & { reason: IndexFailReason };

const TAG = "templates";
const INDEX_TIMEOUT_MS = 10_000;
const CALL_TIMEOUT_MS = 15_000;
const UPLOAD_TIMEOUT_MS = 120_000;
/**
 * One commit's wait. The site's commit route verifies every staged object,
 * copies up to 60 of them live and patches the index before it answers, under
 * its own `maxDuration = 60` (libi-site app/api/templates/publish/commit/route.ts)
 * — the 15 s every other call gets gave up on a commit that was still
 * working, and only the replay finished it (2026-09-26 live check). So the
 * wait is the site's bound plus a margin for the round trip and a cold start:
 * a commit is given up only once the site has ended the request, and the
 * replay (lib/jobs/runners/template-publish.ts) stays the net for a lost
 * answer. Below COMMIT_MAY_RUN_MS (lib/templates/store.ts, the site's 2-minute
 * commit lease), and below the publish job's no-progress watchdog.
 */
export const COMMIT_TIMEOUT_MS = 75_000;
/** 20,000 entries at well under 1 KB each; anything bigger is not an index. */
const MAX_INDEX_BYTES = 64 * 1024 * 1024;
/** `mine` (200 templates × 30 days of counts) is the largest JSON answer. */
const MAX_JSON_BYTES = 4 * 1024 * 1024;
const MAX_ERROR_CHARS = 300;

// ---------------------------------------------------------------------------
// Bases
// ---------------------------------------------------------------------------

/** Throws only in test mode when the studio port is unreadable — callers below catch it. */
export function catalogApiBase(): string {
  return catalogApiBaseFor(catalogSource());
}

function bucketBase(): string {
  return catalogBucketBaseFor();
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

/** https, or http to loopback (a local site, the test-mode fixture); never credentialed. */
function transportProblem(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return "not a URL";
  }
  if (u.username || u.password) return "carries credentials";
  if (u.protocol === "https:") return null;
  if (u.protocol === "http:" && LOOPBACK_HOSTS.has(u.hostname)) return null;
  return "is not https";
}

/** The API base, or why it cannot be used. Checked before every request: the creator key must not cross plain http. */
function apiBase(): { ok: true; base: string } | CloudFail {
  const base = catalogApiBase();
  const problem = transportProblem(base);
  if (problem) return { ok: false, error: `the catalog site URL ${problem} (it must be https)` };
  return { ok: true, base };
}

// ---------------------------------------------------------------------------
// Text and paths
// ---------------------------------------------------------------------------

// The site's own character rules (./text-rules is its verbatim copy): controls,
// the bidi overrides and isolates, and stray Unicode TAG characters — an
// invisible channel into the agent that reads the catalog. Single-line text
// also refuses U+2028/U+2029. LRM/RLM and the three subdivision flags pass.
function singleLine(max: number, min = 0) {
  return z.string().min(min).max(max).refine((s) => singleLineTextProblem(s) === null, "control, bidi or TAG characters");
}
function multiLine(max: number) {
  return z.string().max(max).refine((s) => multiLineTextProblem(s) === null, "control, bidi or TAG characters");
}

const nameText = singleLine(TEMPLATE_LIMITS.nameChars, 1);
const descriptionText = multiLine(TEMPLATE_LIMITS.descriptionChars);
const tagsList = z.array(z.string().regex(TEMPLATE_TAG_RE)).max(TEMPLATE_LIMITS.tags);
const nicknameText = singleLine(32, 1);
const authorIdText = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const isoDate = z.string().max(40).datetime({ offset: true });
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const finiteNonNeg = z.number().nonnegative().finite();
const version = z.number().int().positive().max(1_000_000);
const cloudId = z.string().regex(CLOUD_ID_PATTERN);

/** Where a template's objects live, relative to the bucket base — the site's layout. */
function templateFolder(id: string, v: number): string {
  return `templates/${id}/v${v}/`;
}

/** Where a publish's uploads are staged, relative to the bucket base — the site's layout (`tmp/**` expires after a day). */
function stagingFolder(id: string, v: number): string {
  return `tmp/${id}/v${v}/`;
}

// Lower-case path segments of [a-z0-9._-] starting with [a-z0-9]: no `..`, no
// `%`-escapes, no `?`/`#`, no scheme, no absolute path, no empty segment.
const SAFE_REL_PATH = /^[a-z0-9][a-z0-9._-]*(\/[a-z0-9][a-z0-9._-]*)*\/?$/;

/**
 * A relative media path is trusted only when it is plain, stays inside
 * `folder`, and resolves under this environment's bucket base.
 */
function insideFolder(path: string, folder: string, base: string): boolean {
  if (path.length > 512 || !SAFE_REL_PATH.test(path) || !path.startsWith(folder)) return false;
  try {
    return new URL(path, base).href === base + path;
  } catch {
    return false;
  }
}

// The file names the site admits: CLOUD_FILE_NAME_PATTERN (./constants).
const FILE_NAME = CLOUD_FILE_NAME_PATTERN;
const MD5_BASE64 = /^[A-Za-z0-9+/]{22}==$/;
const CONTENT_TYPE = /^[a-z0-9.+-]+\/[a-z0-9.+-]+(; ?charset=[a-z0-9-]+)?$/i;

/** A message from the network, made safe to hand on: no secret, no control characters, bounded. */
function scrub(text: string, secret?: string): string {
  let out = secret ? text.split(secret).join("[creator key]") : text;
  const bypass = bypassTokenForScrub();
  if (bypass) out = out.split(bypass).join("[bypass token]");
  out = out.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069\u{e0000}-\u{e007f}]/gu, " ");
  return out.length > MAX_ERROR_CHARS ? `${out.slice(0, MAX_ERROR_CHARS - 1)}…` : out;
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

export const catalogIndexEntrySchema = z.object({
  id: cloudId,
  name: nameText,
  description: descriptionText,
  tags: tagsList,
  nickname: nicknameText,
  authorId: authorIdText,
  version,
  hasCode: z.boolean(),
  canvas: z.object({ width: z.number().positive().max(16_384), height: z.number().positive().max(16_384) }),
  duration: finiteNonNeg.max(24 * 60 * 60),
  slotCount: count.max(1000),
  poster: z.string(),
  video: z.string(),
  usesTotal: count,
  uses7d: count,
  heat: finiteNonNeg,
  heatAt: finiteNonNeg,
  createdAt: isoDate,
  updatedAt: isoDate,
});
export type CatalogIndexEntry = z.infer<typeof catalogIndexEntrySchema>;

const catalogIndexSchema = z.object({
  schema: z.literal(1),
  generatedAt: isoDate,
  usageRefreshedAt: isoDate.nullable(),
  base: z.string().max(512),
  // Over the cap is not an index the site wrote: refused whole (the cached
  // copy is kept) rather than truncated to an arbitrary 20,000.
  entries: z.array(z.unknown()).max(INDEX_CAP),
});
export interface CatalogIndex {
  schema: 1;
  generatedAt: string;
  usageRefreshedAt: string | null;
  base: string;
  entries: CatalogIndexEntry[];
}

const fileEntrySchema = z.object({
  name: z.string().regex(FILE_NAME),
  bytes: count.max(CAPS.total),
  contentType: z.string().max(100).regex(CONTENT_TYPE),
  md5: z.string().regex(MD5_BASE64),
});

const cloudTemplateSchema = catalogIndexEntrySchema.omit({ heat: true, heatAt: true }).extend({
  files: z
    .array(fileEntrySchema)
    .max(MAX_FILES)
    .refine((fs) => new Set(fs.map((f) => f.name)).size === fs.length, "duplicate file names"),
  prefix: z.string(),
  base: z.string().max(512),
  example: z.object({
    durationSec: finiteNonNeg.max(60),
    width: z.number().int().positive().max(16_384),
    height: z.number().int().positive().max(16_384),
  }),
  /**
   * Uses over the last 30 days and the UTC day it was last used (day
   * granularity only), for the template's page. A newer site sends them; an
   * older one doesn't, and a value libi can't read reads as absent rather
   * than refusing the whole document (an install reads this schema too).
   */
  uses30d: count.optional().catch(undefined),
  lastUsedDay: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable()
    .optional()
    .catch(undefined),
});
/** The site's `shapePublicTemplate` output, validated. */
export type CloudTemplate = z.infer<typeof cloudTemplateSchema>;

const mineTemplateSchema = z.object({
  id: cloudId,
  name: nameText,
  version,
  hidden: z.boolean(),
  /** Hidden by moderation (reports or a takedown): its owner cannot show it again. */
  moderated: z.boolean(),
  /** Live, but its catalog entry is not known to be written yet (the site's refresh lists it). */
  indexPending: z.boolean(),
  usesTotal: count,
  uses7d: count,
  byDay: z.record(z.string().regex(/^\d{4}-?\d{2}-?\d{2}$/), count).refine((r) => Object.keys(r).length <= 400, "too many days"),
  createdAt: isoDate,
  updatedAt: isoDate,
  /**
   * Why the catalog took it down (the statement of reasons, Terms §11): set by
   * an operator, non-null only for a moderated template that has one; absent
   * from an older site. Every part degrades rather than failing: an unknown
   * reason reads `other`, a note that breaks the text rules reads null, and a
   * statement libi can't read at all reads as none — never dropping the
   * creator's whole entry, which `mineShowsLive` reads fail-closed.
   */
  moderation: z
    .object({
      reason: z.enum(MODERATION_REASONS).catch("other"),
      note: multiLine(MODERATION_NOTE_MAX).nullable().catch(null),
      at: isoDate,
    })
    .nullable()
    .optional()
    .catch(null),
});
export type MineTemplate = z.infer<typeof mineTemplateSchema>;

const mineResponseSchema = z.object({
  nickname: nicknameText.nullable(),
  templates: z.array(z.unknown()).max(1000),
});

// Signed-upload headers: the names GCS signs, nothing a caller could use to
// smuggle credentials or cookies; printable ASCII values (no CR/LF).
const UPLOAD_HEADER_NAMES = new Set(["content-type", "content-disposition", "content-md5", "cache-control"]);
const uploadHeaders = z
  .record(z.string().regex(/^[A-Za-z0-9-]{1,64}$/), z.string().max(256).regex(/^[\x20-\x7e]*$/))
  .refine((h) => Object.keys(h).length <= 10, "too many headers")
  .refine((h) => Object.keys(h).every((k) => UPLOAD_HEADER_NAMES.has(k.toLowerCase()) || k.toLowerCase().startsWith("x-goog-")), "unexpected header");

const signedUploadSchema = z.object({
  name: z.string().regex(FILE_NAME),
  url: z.string().max(8192),
  headers: uploadHeaders,
});
export type SignedUpload = z.infer<typeof signedUploadSchema>;

const prepareResponseSchema = z.object({
  templateId: cloudId,
  version,
  uploads: z.array(signedUploadSchema).max(MAX_FILES),
  expiresAt: isoDate.optional(),
});
const commitResponseSchema = z.object({ templateId: cloudId, version, indexed: z.boolean().optional() });
const reportResponseSchema = z.object({ hidden: z.boolean() });
const nicknameResponseSchema = z.object({ nickname: nicknameText });
const templateResponseSchema = z.object({ template: z.unknown() });

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

/**
 * One request. Never throws, never follows a redirect (a redirect could carry
 * the bearer, or a signed PUT, somewhere else), never caches. `logUrl` is what
 * may appear in a log line — never a signed URL's query.
 */
async function call(url: string, init: RequestInit, timeoutMs: number, logUrl: string, secret?: string): Promise<{ ok: true; res: Response } | CloudFail> {
  // The development site's Vercel bypass token rides here and nowhere else:
  // `{}` for every URL but one over https to exactly that origin
  // (catalog-setting.ts#bypassHeadersFor) — never production, a bucket or a
  // signed upload URL — and `redirect: "error"` never carries it on.
  const bypass = bypassHeadersFor(url);
  const headers = Object.keys(bypass).length > 0 ? { ...(init.headers as Record<string, string> | undefined), ...bypass } : init.headers;
  try {
    const res = await fetch(url, { ...init, headers, redirect: "error", cache: "no-store", signal: AbortSignal.timeout(timeoutMs) });
    return { ok: true, res };
  } catch (err) {
    const error = scrub(err instanceof Error ? err.message : String(err), secret);
    logger.debug({ tag: TAG, op: "cloud_call_failed", url: logUrl, error }, "catalog call failed");
    return { ok: false, error };
  }
}

/** Parse a `{ ok: true, ... }` answer against `schema`; a non-2xx or `ok: false` comes back with the site's message. */
async function jsonCall<S extends z.ZodTypeAny>(
  path: string,
  init: RequestInit,
  schema: S,
  secret?: string,
  timeoutMs: number = CALL_TIMEOUT_MS,
): Promise<({ ok: true } & z.infer<S>) | CloudFail> {
  const b = apiBase();
  if (!b.ok) return b;
  const url = `${b.base}${path}`;
  const r = await call(url, init, timeoutMs, url, secret);
  if (!r.ok) return r;
  let body: unknown = null;
  let unreadable: string | null = null;
  try {
    body = JSON.parse((await readBodyWithCap(r.res, MAX_JSON_BYTES)).toString("utf8"));
  } catch (err) {
    unreadable = err instanceof SyntaxError ? "not JSON" : scrub(err instanceof Error ? err.message : String(err), secret);
  }
  // A 2xx whose body could not be read (over the cap, cut off, not JSON) is
  // THAT failure — never "answered 200", which reads like success.
  if (r.res.ok && unreadable !== null) {
    return { ok: false, status: r.res.status, error: `the catalog's answer could not be read (${unreadable})` };
  }
  const envelope = (typeof body === "object" && body !== null ? body : {}) as { ok?: unknown; error?: unknown; code?: unknown };
  if (!r.res.ok || envelope.ok !== true) {
    const error = typeof envelope.error === "string" && envelope.error ? scrub(envelope.error, secret) : `catalog answered ${r.res.status}`;
    // Only one of the site's own codes: anything else is no code at all.
    const code = isPublishErrorCode(envelope.code) ? envelope.code : undefined;
    const fail: CloudFail = code === undefined ? { ok: false, status: r.res.status, error } : { ok: false, status: r.res.status, error, code };
    const wait = retryAfterMs(r.res);
    return wait === undefined ? fail : { ...fail, retryAfterMs: wait };
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    logger.warn({ tag: TAG, op: "cloud_bad_response", path: path.replace(/\/[a-z2-7]{20}(?=\/|$)/, "/<id>") }, "catalog answer failed validation");
    return { ok: false, status: r.res.status, error: "the catalog sent an answer libi could not read" };
  }
  return { ok: true, ...(parsed.data as object) } as { ok: true } & z.infer<S>;
}

function authHeaders(key: string): Record<string, string> {
  return { Authorization: `Bearer ${key}`, "Content-Type": "application/json", Accept: "application/json" };
}

const NOT_A_KEY: CloudFail = { ok: false, error: "the creator key is malformed" };

/** Every public call runs inside this: whatever goes wrong comes back as `{ ok: false }`. */
async function neverThrow<T>(op: string, fn: () => Promise<T | CloudFail>, secret?: string): Promise<T | CloudFail> {
  try {
    return await fn();
  } catch (err) {
    // Only reachable by a bug or an unreadable studio port — scrubbed all the same.
    const error = scrub(err instanceof Error ? err.message : String(err), secret);
    logger.warn({ tag: TAG, op: `cloud_${op}_failed`, error }, "catalog client failed");
    return { ok: false, error };
  }
}

export function decodeIndexBody(buf: Buffer): unknown {
  const raw = buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b ? gunzipSync(buf, { maxOutputLength: MAX_INDEX_BYTES }) : buf;
  return JSON.parse(raw.toString("utf8"));
}

// ---------------------------------------------------------------------------
// Public calls
// ---------------------------------------------------------------------------

export async function fetchIndex(opts: {
  etag: string | null;
}): Promise<{ ok: true; notModified: true } | { ok: true; notModified: false; etag: string | null; index: CatalogIndex } | IndexFail> {
  const r = await neverThrow("index", async () => {
    const b = apiBase();
    if (!b.ok) return { ...b, reason: "unreachable" as const };
    const headers: Record<string, string> = { Accept: "application/json" };
    if (opts.etag) headers["If-None-Match"] = opts.etag;
    const url = `${b.base}/index`;
    const r = await call(url, { headers }, INDEX_TIMEOUT_MS, url);
    if (!r.ok) return { ...r, reason: "unreachable" as const };
    if (r.res.status === 304) return { ok: true as const, notModified: true as const };
    if (!r.res.ok) return { ok: false as const, status: r.res.status, error: `index answered ${r.res.status}`, reason: "http_error" as const };
    const invalid = (error: string): IndexFail => ({ ok: false, error, reason: "invalid_index" });
    let parsed: unknown;
    try {
      parsed = decodeIndexBody(await readBodyWithCap(r.res, MAX_INDEX_BYTES));
    } catch (err) {
      return invalid(`index body unreadable: ${scrub(err instanceof Error ? err.message : String(err))}`);
    }
    const shape = catalogIndexSchema.safeParse(parsed);
    if (!shape.success) {
      const over = typeof parsed === "object" && parsed !== null && Array.isArray((parsed as { entries?: unknown }).entries) && (parsed as { entries: unknown[] }).entries.length > INDEX_CAP;
      return invalid(over ? `index has more than ${INDEX_CAP} entries` : "index has the wrong shape");
    }
    const base = bucketBase();
    if (shape.data.base !== base) return invalid(`index base ${scrub(shape.data.base)} is not this environment's bucket base`);
    const entries: CatalogIndexEntry[] = [];
    const seen = new Set<string>();
    let dropped = 0;
    for (const raw of shape.data.entries) {
      const e = catalogIndexEntrySchema.safeParse(raw);
      if (!e.success || seen.has(e.data.id)) {
        dropped += 1;
        continue;
      }
      const folder = templateFolder(e.data.id, e.data.version);
      if (!insideFolder(e.data.poster, folder, base) || !insideFolder(e.data.video, folder, base)) {
        dropped += 1;
        continue;
      }
      seen.add(e.data.id);
      entries.push(e.data);
    }
    if (dropped > 0) logger.warn({ tag: TAG, op: "cloud_index_entries_dropped", dropped }, "catalog index entries failed validation");
    const etag = r.res.headers.get("etag");
    return {
      ok: true as const,
      notModified: false as const,
      etag: etag && etag.length <= 256 && singleLineTextProblem(etag) === null ? etag : null,
      index: { ...shape.data, entries },
    };
  });
  // neverThrow's own catch (a bug, or an unreadable studio port) carries no reason.
  return r.ok || "reason" in r ? r : { ...r, reason: "unreachable" };
}

export async function getCloudTemplate(cloudIdArg: string): Promise<{ ok: true; template: CloudTemplate } | CloudFail> {
  return neverThrow("get", async () => {
    if (!CLOUD_ID_PATTERN.test(cloudIdArg)) return { ok: false, error: "not a catalog template id" };
    const r = await jsonCall(`/${cloudIdArg}`, { headers: { Accept: "application/json" } }, templateResponseSchema);
    if (!r.ok) return r;
    const t = cloudTemplateSchema.safeParse(r.template);
    if (!t.success) return { ok: false, error: "template document has the wrong shape" };
    const base = bucketBase();
    if (t.data.base !== base) return { ok: false, error: `template base ${scrub(t.data.base)} is not this environment's bucket base` };
    if (t.data.id !== cloudIdArg) return { ok: false, error: "the catalog answered with a different template" };
    const folder = templateFolder(t.data.id, t.data.version);
    if (t.data.prefix !== folder || !insideFolder(t.data.poster, folder, base) || !insideFolder(t.data.video, folder, base)) {
      return { ok: false, error: "template files are outside its folder in the bucket" };
    }
    return { ok: true as const, template: t.data };
  });
}

// `tmp/<template id>/v<version>/` — the only folder a publish may write to.
const STAGING_PATH = /^tmp\/[a-z2-7]{20}\/v[1-9][0-9]{0,6}\//;

/**
 * Is `url` a signed PUT target this environment may upload to? https and
 * uncredentialed (loopback http only in test mode), no fragment, and — after
 * WHATWG normalisation, so `..`, `%2e%2e` and `\` are already resolved — exactly
 * `<bucket base>tmp/<id>/v<n>/<name>`: never a live `templates/…` object, the
 * index, or another file than the one it claims to be for. `staging` pins the
 * id and version when the caller knows them (prepare does).
 */
function uploadUrlProblem(upload: { name: string; url: string }, base: string, staging?: string): string | null {
  let u: URL;
  try {
    u = new URL(upload.url);
  } catch {
    return "is not a URL";
  }
  if (u.username || u.password) return "carries credentials";
  if (u.protocol !== "https:" && !(isTestMode() && u.protocol === "http:")) return "is not https";
  if (u.hash) return "has a fragment";
  const at = u.origin + u.pathname;
  if (!at.startsWith(base)) return "is not on the bucket host";
  const rel = at.slice(base.length);
  const folder = STAGING_PATH.exec(rel)?.[0];
  if (!folder || (staging !== undefined && folder !== staging)) return "is outside this publish's staging folder";
  if (rel !== folder + upload.name) return "names a different file";
  return null;
}

function withSchemaHash(body: Record<string, unknown>): string {
  // Stamped last, so no caller can send a stale or missing hash: the site
  // refuses a schema it does not know with a 409 that says "update libi". The
  // one serialiser the preflight measures against the site's body cap.
  return publishRequestJson(body);
}

function manifestNames(body: Record<string, unknown>): string[] | null {
  if (!Array.isArray(body.files)) return null;
  return body.files.map((f) => (typeof f === "object" && f !== null && typeof (f as { name?: unknown }).name === "string" ? (f as { name: string }).name : ""));
}

/**
 * Sign the uploads for a publish. `expiresAt` (ms) is when the signed URLs
 * stop working: the site's word, but never later than their fixed lifetime
 * counted from before the call — a retry trusts it to decide whether the
 * same URLs can still finish an upload.
 */
export async function publishPrepare(
  key: string,
  body: Record<string, unknown>,
): Promise<{ ok: true; templateId: string; version: number; uploads: SignedUpload[]; expiresAt: number } | CloudFail> {
  return neverThrow("prepare", async () => {
    if (!CREATOR_KEY_PATTERN.test(key)) return NOT_A_KEY;
    const latest = Date.now() + SIGNED_URL_TTL_MS;
    const r = await jsonCall("/publish/prepare", { method: "POST", headers: authHeaders(key), body: withSchemaHash(body) }, prepareResponseSchema, key);
    if (!r.ok) return r;
    const base = bucketBase();
    const names = r.uploads.map((u) => u.name);
    if (new Set(names).size !== names.length) return { ok: false, error: "the catalog signed the same file twice" };
    const manifest = manifestNames(body);
    if (manifest && (manifest.length !== names.length || !names.every((n) => manifest.includes(n)))) {
      return { ok: false, error: "the catalog signed uploads for a different set of files" };
    }
    const staging = stagingFolder(r.templateId, r.version);
    for (const u of r.uploads) {
      const problem = uploadUrlProblem(u, base, staging);
      if (problem) return { ok: false, error: `signed url for ${u.name} ${problem}` };
    }
    const said = r.expiresAt === undefined ? latest : Date.parse(r.expiresAt);
    return { ok: true as const, templateId: r.templateId, version: r.version, uploads: r.uploads, expiresAt: Math.min(said, latest) };
  }, key);
}

/** PUT `buffer` to a signed URL with exactly the headers the site pinned. */
export async function uploadSigned(upload: SignedUpload, buffer: Buffer): Promise<{ ok: true } | CloudFail> {
  return neverThrow("upload", async () => {
    const shape = signedUploadSchema.safeParse(upload);
    if (!shape.success) return { ok: false, error: "signed upload has the wrong shape" };
    const problem = uploadUrlProblem(shape.data, bucketBase());
    if (problem) return { ok: false, error: `signed url for ${shape.data.name} ${problem}` };
    const logUrl = `bucket:${shape.data.name}`;
    const r = await call(shape.data.url, { method: "PUT", headers: shape.data.headers, body: new Uint8Array(buffer) }, UPLOAD_TIMEOUT_MS, logUrl);
    if (!r.ok) return r;
    // Release the socket; GCS's XML body (success or error) is never shown.
    await r.res.body?.cancel().catch(() => undefined);
    if (!r.res.ok) return { ok: false, status: r.res.status, error: `upload of ${shape.data.name} answered ${r.res.status}` };
    return { ok: true as const };
  });
}

/**
 * A commit refusal that is a verdict on THAT commit — it will never make this
 * body live under this (id, version) — with the status the site sends it
 * under (lib/templates/publish.ts). Decided by the code alone: an answer
 * without one (an intermediary's 429 or 5xx, a timeout, a dropped
 * connection) says nothing about whether an earlier send of the same commit
 * landed, whatever its words.
 *
 * `replay_mismatch` is a verdict on this body, but it also says the version
 * IS live (published from another body): never a reason to give the publish
 * up. `forbidden` is final only for this key.
 */
export type DefinitiveRefusal = "expired" | "nothing_pending" | "wrong_version" | "replay_mismatch" | "forbidden";
const DEFINITIVE_STATUS: Record<DefinitiveRefusal, number> = { expired: 410, nothing_pending: 409, wrong_version: 409, replay_mismatch: 409, forbidden: 403 };

function isDefinitive(code: string): code is DefinitiveRefusal {
  return Object.hasOwn(DEFINITIVE_STATUS, code);
}

/** Which definitive refusal `r` is, or null: its code, under the status the site sends that code with. */
export function definitiveRefusal(r: CloudFail): DefinitiveRefusal | null {
  return r.code !== undefined && isDefinitive(r.code) && r.status === DEFINITIVE_STATUS[r.code] ? r.code : null;
}

// What libi says when the site refuses with `moderated`; defined with the constants so the Templates page can show it too.
export { MODERATED_MESSAGE };

/**
 * The message to hand on for a refusal: libi's own for `moderated`,
 * `creator_not_approved` and `creator_request_closed`, which each have one
 * meaning whatever the site's text says; the (scrubbed) site text for
 * everything else.
 */
export function refusalMessage(r: CloudFail): string {
  if (r.code === "moderated") return MODERATED_MESSAGE;
  if (r.code === "creator_not_approved") return CREATOR_NOT_APPROVED_MESSAGE;
  if (r.code === "creator_request_closed") return CREATOR_REQUEST_CLOSED_MESSAGE;
  return r.error;
}

/** The site's invite-only gate (403 `creator_not_approved`): a verdict on the creator key, never retried. */
export function isCreatorNotApproved(r: CloudFail): boolean {
  return r.status === 403 && r.code === "creator_not_approved";
}

/**
 * Is `r` the catalog saying there is no such template to get — `not_found`
 * (404: never published, or hidden, which reads the same to anyone but its
 * owner) or `gone` (410: its files were deleted)? Both are definitive, each
 * only under its own status: an intermediary's bare 404 or a timeout is not.
 */
export function isNoSuchTemplate(r: CloudFail): boolean {
  return (r.code === "not_found" && r.status === 404) || (r.code === "gone" && r.status === 410);
}

/**
 * A prepare or commit the site turned away only because a commit of the same
 * publish is still running (409, code `busy`): wait and try again.
 */
export function isPublishBusy(r: CloudFail): boolean {
  return r.status === 409 && r.code === "busy";
}

/**
 * The site's kill switch (503 `publishing_paused`): prepare and commit refuse
 * everything, replays included, before touching any state — so this request
 * recorded nothing and is over. Not a verdict on the publish either: a pending
 * one stays, and the same commit replayed once publishing resumes gets its
 * receipt (the site keeps receipts 7 days). Only under its own status: an
 * intermediary's bare 503 is no answer at all.
 */
export function isPublishingPaused(r: CloudFail): boolean {
  return r.status === 503 && r.code === "publishing_paused";
}

/**
 * The catalog-wide daily cap (429 `caps_global`, on new templates or on
 * prepares): every attempt until the next UTC day gets the same answer, so
 * nothing retries it that day.
 */
export function isGlobalCap(r: CloudFail): boolean {
  return r.status === 429 && r.code === "caps_global";
}

/** The next 00:00 UTC after `now`: when the site's catalog-wide daily caps reset. */
export function nextUtcDay(now = Date.now()): Date {
  const d = new Date(now);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1));
}

/**
 * Make a prepared publish live. The site answers a REPLAY of a commit that
 * already succeeded (same body) with the same success, so a caller that never
 * saw the answer may send it again. `indexed: false`: the template is live,
 * but the catalog's index did not take it yet — still published.
 */
export async function publishCommit(
  key: string,
  body: Record<string, unknown>,
): Promise<{ ok: true; templateId: string; version: number; indexed: boolean } | CloudFail> {
  return neverThrow("commit", async () => {
    if (!CREATOR_KEY_PATTERN.test(key)) return NOT_A_KEY;
    const r = await jsonCall("/publish/commit", { method: "POST", headers: authHeaders(key), body: withSchemaHash(body) }, commitResponseSchema, key, COMMIT_TIMEOUT_MS);
    if (!r.ok) return r;
    return { ok: true as const, templateId: r.templateId, version: r.version, indexed: r.indexed !== false };
  }, key);
}

export async function reportUse(cloudIdArg: string): Promise<{ ok: true } | CloudFail> {
  return neverThrow("use", async () => {
    if (!CLOUD_ID_PATTERN.test(cloudIdArg)) return { ok: false, error: "not a catalog template id" };
    const r = await jsonCall(`/${cloudIdArg}/use`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }, z.object({}));
    if (!r.ok) return r;
    return { ok: true as const };
  });
}

/**
 * Report a public template with one of the fixed reasons and, optionally, the
 * reporter's own words (`details`, trimmed, ≤ REPORT_DETAILS_MAX, the site's
 * multi-line character rules). Blank details send exactly `{ reason }`, as
 * before details existed; details the site would refuse are refused here,
 * before any request.
 */
export async function reportTemplate(cloudIdArg: string, reason: ReportReason, details?: string): Promise<{ ok: true; hidden: boolean } | CloudFail> {
  return neverThrow("report", async () => {
    if (!CLOUD_ID_PATTERN.test(cloudIdArg)) return { ok: false, error: "not a catalog template id" };
    if (!REPORT_REASONS.includes(reason)) return { ok: false, error: "unknown reason" };
    const text = details?.trim() ?? "";
    if (text.length > REPORT_DETAILS_MAX) return { ok: false, error: `details over ${REPORT_DETAILS_MAX} characters` };
    if (text && multiLineTextProblem(text) !== null) return { ok: false, error: "details carry control, bidi or TAG characters" };
    const r = await jsonCall(
      `/${cloudIdArg}/report`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(text ? { reason, details: text } : { reason }) },
      reportResponseSchema,
    );
    if (!r.ok) return r;
    return { ok: true as const, hidden: r.hidden };
  });
}

/**
 * Does the creator's own list show `cloudIdArg` live at `version` or later —
 * the site's own test for "that commit landed"? Fails closed: it answers
 * `live: false` only when every entry of the list could be read, so an entry
 * the schema would drop (a renamed field, a new date format) is "cannot
 * tell", never "not there". The id and version are matched on the RAW entry,
 * so a landed template is recognised whatever else about its entry drifted.
 */
export async function mineShowsLive(key: string, cloudIdArg: string, version: number): Promise<{ ok: true; live: boolean } | CloudFail> {
  return neverThrow("mine", async () => {
    if (!CREATOR_KEY_PATTERN.test(key)) return NOT_A_KEY;
    const r = await jsonCall("/mine", { headers: authHeaders(key) }, mineResponseSchema, key);
    if (!r.ok) return r;
    let unreadable = 0;
    for (const raw of r.templates) {
      const entry = (typeof raw === "object" && raw !== null ? raw : {}) as { id?: unknown; version?: unknown };
      if (entry.id === cloudIdArg && typeof entry.version === "number" && Number.isSafeInteger(entry.version) && entry.version >= version) {
        return { ok: true as const, live: true };
      }
      if (!mineTemplateSchema.safeParse(raw).success) unreadable += 1;
    }
    if (unreadable > 0) {
      logger.warn({ tag: TAG, op: "cloud_mine_entries_dropped", dropped: unreadable }, "creator's templates failed validation");
      return { ok: false, status: 200, error: `${unreadable} of the creator's templates could not be read` };
    }
    return { ok: true as const, live: false };
  }, key);
}

/**
 * The creator's templates as libi can read them. `dropped` counts entries the
 * site listed that failed libi's schema: they still exist and still belong to
 * the key — a caller deciding whether the key has been used must count them.
 */
export async function fetchMine(key: string): Promise<{ ok: true; nickname: string | null; templates: MineTemplate[]; dropped?: number } | CloudFail> {
  return neverThrow("mine", async () => {
    if (!CREATOR_KEY_PATTERN.test(key)) return NOT_A_KEY;
    const r = await jsonCall("/mine", { headers: authHeaders(key) }, mineResponseSchema, key);
    if (!r.ok) return r;
    const templates: MineTemplate[] = [];
    let dropped = 0;
    for (const raw of r.templates) {
      const t = mineTemplateSchema.safeParse(raw);
      if (t.success) templates.push(t.data);
      else dropped += 1;
    }
    if (dropped > 0) logger.warn({ tag: TAG, op: "cloud_mine_entries_dropped", dropped }, "creator's templates failed validation");
    return { ok: true as const, nickname: r.nickname, templates, ...(dropped > 0 ? { dropped } : {}) };
  }, key);
}

/**
 * A hide/unhide that did not come back `ok`. `outcomeUnknown` is set when the
 * request went out and libi cannot tell whether the site applied it: no answer,
 * a 5xx (each after the last try), or a 2xx libi could not read. Without it the
 * refusal is definite — nothing changed.
 */
export type VisibilityFail = CloudFail & { outcomeUnknown?: true };

/** Tries of a HIDE the site answered with a 5xx or not at all, and the waits between them. An unhide is never retried. */
const VISIBILITY_ATTEMPTS = 3;
const VISIBILITY_BACKOFF_MS = [1_000, 3_000] as const;
const MAX_RETRY_AFTER_MS = 10_000;
/**
 * One hide/unhide attempt's wait: the site's own bound on that PATCH
 * (libi-site app/api/templates/[id]/route.ts `maxDuration = 60`). An unhide
 * moves every file of the version back before it answers, which can take
 * several seconds; given up sooner, a request the site is still finishing
 * would be re-sent into its own `busy`. Never longer: past 60 s the site has
 * ended the request, so a retry is safe.
 */
export const VISIBILITY_TIMEOUT_MS = 60_000;

/**
 * Hide (unpublish) or show again one of the creator's templates: PATCH
 * `/<id> { hidden }`. A HIDE is idempotent and conservative, so a 5xx or a
 * request that got no answer is retried (twice, with backoff, or the site's
 * own `Retry-After` up to 10 s) — a hide the user asked for must not stop at
 * one transient failure. An UNHIDE is sent exactly once, whatever comes back:
 * the site lets a hide sent while an unhide of the same template is still
 * running win (the hide answers 200, the unhide 409 `busy`), so replaying an
 * unhide — after `busy`, a 5xx or no answer alike — could undo the owner's
 * hide. A hide can answer 409 `busy` too, when a LATER unhide of the same
 * template overtook it; it is not retried either, for the same reason in
 * reverse. The caller re-reads `/mine` and shows what the site says instead.
 * Any other refusal is final: `moderated` (403, the owner
 * can't show it again), `gone` (410), `not_found`, `forbidden`, … — switch on
 * `code`. A hidden template whose answer, or whose later `/mine` entry, says
 * `indexPending: true` may still be listed: hide it again.
 */
export async function setTemplateHidden(
  key: string,
  cloudIdArg: string,
  hidden: boolean,
  opts: { sleep?: (ms: number) => Promise<void> } = {},
): Promise<{ ok: true; template: MineTemplate } | VisibilityFail> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  return neverThrow<{ ok: true; template: MineTemplate } | VisibilityFail>("visibility", async () => {
    if (!CREATOR_KEY_PATTERN.test(key)) return NOT_A_KEY;
    if (!CLOUD_ID_PATTERN.test(cloudIdArg)) return { ok: false, error: "not a catalog template id" };
    // Checked here, before anything is sent, so that inside the loop a failure
    // with no status can only mean a request that went out and got no answer.
    const base = apiBase();
    if (!base.ok) return base;
    let last: CloudFail = { ok: false, error: "not attempted" };
    const attempts = hidden ? VISIBILITY_ATTEMPTS : 1;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (attempt > 0) await sleep(Math.min(last.retryAfterMs ?? VISIBILITY_BACKOFF_MS[attempt - 1], MAX_RETRY_AFTER_MS));
      const r = await jsonCall(`/${cloudIdArg}`, { method: "PATCH", headers: authHeaders(key), body: JSON.stringify({ hidden }) }, templateResponseSchema, key, VISIBILITY_TIMEOUT_MS);
      if (r.ok) {
        const t = mineTemplateSchema.safeParse(r.template);
        // The site answered 2xx: the change landed, only its answer is unreadable.
        if (!t.success) return { ok: false, status: 200, error: "the catalog sent an answer libi could not read", outcomeUnknown: true };
        return { ok: true as const, template: t.data };
      }
      last = r;
      const transient = r.status === undefined || r.status >= 500;
      if (!transient) {
        // A 2xx whose body could not be read is jsonCall's own failure — also a change that may have landed.
        return r.status !== undefined && r.status < 300 ? { ...r, outcomeUnknown: true } : r;
      }
      logger.info({ tag: TAG, op: "cloud_visibility_retry", attempt: attempt + 1, status: r.status ?? null, hidden }, "hide/unhide failed transiently");
    }
    // No answer or a 5xx on the last try: the site may have applied it anyway.
    return { ...last, outcomeUnknown: true };
  }, key);
}

export async function setNickname(key: string, nickname: string): Promise<{ ok: true; nickname: string } | CloudFail> {
  return neverThrow("nickname", async () => {
    if (!CREATOR_KEY_PATTERN.test(key)) return NOT_A_KEY;
    const r = await jsonCall("/authors/me", { method: "PUT", headers: authHeaders(key), body: JSON.stringify({ nickname }) }, nicknameResponseSchema, key);
    if (!r.ok) return r;
    return { ok: true as const, nickname: r.nickname };
  }, key);
}

// ---------------------------------------------------------------------------
// Creator approval (invite-only publishing)
// ---------------------------------------------------------------------------

export { CREATOR_STATUSES, type CreatorStatus };

const creatorStatusSchema = z.object({ status: z.enum(CREATOR_STATUSES) });

/** The creator key's approval to publish (libi-site GET /api/templates/creators/me). An unknown status is an unreadable answer. */
export async function creatorStatus(key: string): Promise<{ ok: true; status: CreatorStatus } | CloudFail> {
  return neverThrow("creator_status", async () => {
    if (!CREATOR_KEY_PATTERN.test(key)) return NOT_A_KEY;
    const r = await jsonCall("/creators/me", { headers: authHeaders(key) }, creatorStatusSchema, key);
    return r.ok ? { ok: true as const, status: r.status } : r;
  }, key);
}

/**
 * Apply to publish: the site files (or updates) a pending request and answers
 * the status — `approved`, writing nothing, for a key already approved. 409
 * `creator_request_closed` once the application was turned down. The email is
 * only ever in the body, never logged.
 */
export async function applyAsCreator(
  key: string,
  input: { email: string; note: string; appVersion: string | null },
): Promise<{ ok: true; status: CreatorStatus } | CloudFail> {
  return neverThrow("creator_apply", async () => {
    if (!CREATOR_KEY_PATTERN.test(key)) return NOT_A_KEY;
    const body = JSON.stringify({ email: input.email, note: input.note, ...(input.appVersion ? { appVersion: input.appVersion } : {}) });
    const r = await jsonCall("/creators/me", { method: "POST", headers: authHeaders(key), body }, creatorStatusSchema, key);
    return r.ok ? { ok: true as const, status: r.status } : r;
  }, key);
}
