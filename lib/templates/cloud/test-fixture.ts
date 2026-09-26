/**
 * Test mode's public catalog: libi-site's `/api/templates/*` routes and the
 * catalog bucket, in memory, behind the studio's own
 * `/api/test-mode/templates-catalog/*` (app/api/test-mode/templates-catalog).
 * lib/templates/cloud/client.ts points there whenever LIBI_TEST_MODE is on,
 * so every catalog path — browse, install, apply, publish, use, report, hide —
 * runs offline, at zero cost, through the identical client code.
 *
 * It mirrors the REAL site, not a simplification of it (libi-site
 * lib/templates/{publish,prepare,verify,shape,http}.ts and app/api/templates/**):
 * the same request and response shapes, statuses and messages, and a stable
 * `code` on every refusal (the site's PUBLISH_ERROR_CODES); the schemaHash
 * handshake answered first; uploads signed into `tmp/<id>/v<n>/` and checked
 * at commit against what prepare validated (size, md5, ftyp / JPEG sniff,
 * template.json by canonical value, index.md byte for byte); one pending
 * publish per (id, version) with its receipt kept, so a commit REPLAY answers
 * the same success; reserved ids for a first publish; `indexed: false` when
 * the listing did not land; use dedupe per client per UTC day; five distinct
 * reporters in 24 h hide a template for moderation, with the statement of
 * reasons `reports`; owner hide / unhide with `moderated`, `gone` and `busy`
 * (an unhide clears the statement); creator approval (`creators/me`, the gate
 * on prepare, commit and listing edits — never on a hide — and on a rename
 * by an author who owns any template). Every author's status
 * is `LIBI_TEST_CATALOG_CREATOR` (skill-eval's `catalogCreator:`, default
 * `approved`) until the fixture stores one. Everything the site's clock or concurrency
 * decides (a lease held by another commit, an expired publish, a lost race,
 * the speed bump, contention) is reachable by editing the exposed state or by
 * `injectFixtureFault` / `POST _faults`.
 *
 * Deliberate differences, all invisible to the app: no per-IP speed bump (the
 * `rate_limited` fault stands in), no duplicate-JSON-key check on bodies, no
 * CORS preflight, and the seeds' example videos come from the checkout's
 * `__tests__/helpers/fixtures/video` (a bare ftyp box when that is absent,
 * as in a packed npm install). A "client" — the site's per-address identity
 * for use and report dedupe — is the `x-libi-fixture-client` header, default
 * "local": the app never sends it, so, like the site, it is one client.
 *
 * Every API call is appended to <LIBI_HOME>/test-mode/templates-catalog-calls.jsonl
 * as `{ ts, tool, input, status, code? }` for the skill-eval harness.
 *
 * Test mode shares LIBI_HOME with a normal boot, so what it leaves behind is
 * tagged "test-mode" (lib/templates/cloud/catalog-source.ts): the cached index,
 * a template's cloud id and pending publish, each use. A normal boot treats
 * those as another catalog's — never republished, replayed or reported to the
 * real site — and test mode treats the real site's the same way.
 */
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { storedBytesServing } from "@/lib/http/media-types";
import { getCurrentPort, getLibiHome } from "@/lib/libi-home";
import { serverLogger as logger } from "@/lib/logger";
import { isTestMode } from "@/lib/test-mode";
import {
  CAPS,
  CLOUD_ID_PATTERN,
  EXAMPLE_MAX_LONG_EDGE,
  EXAMPLE_MAX_SECONDS,
  EXAMPLE_MIN_SECONDS,
  FONT_EXTS,
  IMAGE_EXTS,
  MAX_DESCRIPTION,
  MAX_FILES,
  MAX_NAME,
  MAX_TAGS,
  NICKNAME_PATTERN,
  PUBLIC_CODE_TEMPLATES,
  REPORT_DETAILS_MAX,
  REPORT_REASONS,
  SIGNED_URL_TTL_MS,
  TAG_PATTERN,
  TEST_MODE_SOURCE,
  catalogBucketBase,
  type CreatorStatus,
  type ModerationReason,
  type ReportReason,
} from "@/lib/templates/cloud/constants";
import { CODE_TEMPLATES_BLOCKED_ERROR, capForName, contentTypeForName, hasCodeIn, hostedUrlProblem, scaffoldValueProblems, textFileProblem } from "@/lib/templates/cloud/preflight";
import { CREATOR_KEY_PATTERN } from "@/lib/templates/cloud/author-rules";
import {
  FIXTURE_LEFT_OUT_AUTHOR_VALUES,
  FIXTURE_LEFT_OUT_CLOUD_ID,
  FIXTURE_LEFT_OUT_NAME,
  FIXTURE_LEFT_OUT_TAGS,
} from "@/lib/templates/cloud/left-out-fixture";
import type { PublishErrorCode } from "@/lib/templates/cloud/client";
import { MIN_VISIBLE_NAME_CHARS, edgeTextProblem, multiLineTextProblem, singleLineTextProblem, visibleCharCount } from "@/lib/templates/cloud/text-rules";
import type { TemplateScaffold } from "@/lib/templates/scaffold";
import { SCAFFOLD_SCHEMA_SHA256, templateScaffoldSchema } from "@/lib/templates/scaffold-schema";

// ---------------------------------------------------------------------------
// The site's numbers (libi-site lib/templates/constants.ts, http.ts)
// ---------------------------------------------------------------------------

const BODY_CAP = 64 * 1024;
const CREATOR_BODY_CAP = 4 * 1024;
const PREPARE_BODY_CAP = 256 * 1024;
const MAX_PUBLISHES_PER_DAY = 20;
const MAX_TEMPLATES_PER_AUTHOR = 200;
const AUTO_HIDE_REPORTS = 5;
const REPORT_WINDOW_MS = 24 * 60 * 60 * 1000;
const PENDING_PUBLISH_TTL_MS = 60 * 60 * 1000;
const COMMITTED_KEEP_MS = 7 * 24 * 60 * 60 * 1000;
const RESERVATION_KEEP_MS = 7 * 24 * 60 * 60 * 1000;
const BYDAY_KEEP_DAYS = 30;
const RATE_WINDOW_S = 60;
const CONTENDED_RETRY_AFTER_S = 5;
const DAY_MS = 86_400_000;
const ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";

// The site's messages, verbatim (lib/templates/publish.ts, prepare.ts, the routes).
const MSG = {
  unsupportedSchema: "This version of libi can't publish to the catalog — update libi and try again.",
  nicknameFirst: "Set a nickname first (PUT /api/templates/authors/me).",
  noSuchTemplateId: "No template with that id. Leave templateId out to publish a new one.",
  notYours: "That template belongs to another creator key.",
  dailyCap: `You have published ${MAX_PUBLISHES_PER_DAY} times today — try again tomorrow.`,
  totalCap: `You have ${MAX_TEMPLATES_PER_AUTHOR} published templates, the most one creator can have.`,
  commitIds: "commit needs the templateId and version that prepare returned.",
  nothingPending: "Nothing is waiting to be published under that template and version — run prepare again.",
  busy: "This template is being published right now. Wait for that to finish, then try again.",
  expired: "The time to finish this publish ran out — run prepare again.",
  bodyMismatch: "The commit body must be the body sent to prepare, plus templateId and version. Run prepare again.",
  uploadChanged: "An uploaded file changed after it was checked. Run prepare again.",
  alreadyPublished: "That version is already published, from a different body. Run prepare to publish a new version.",
  moderatedPublish: "This template was taken down by moderation, so it can't be published again.",
  unauthorized: "A valid creator key is required.",
  rateLimited: "Too many requests. Try again in a minute.",
  contended: "Too many requests for this template at once. Try again in a few seconds.",
  publishingPaused: "Publishing to the catalog is paused right now. Nothing was published — try again later.",
  globalNewCap: "The catalog has taken all the new templates it can today. Try again tomorrow (UTC).",
  globalPreparesCap: "The catalog has taken all the publishes it can today. Try again tomorrow (UTC).",
  internal: "Something went wrong on our side.",
  badId: "Not a template id.",
  noSuchTemplate: "No such template.",
  unhideModerated: "This template was hidden by moderation and can't be shown again from libi.",
  unhideGone: "This template's files were deleted after it was hidden. Publish a new version, then show it again.",
  unhideBusy: "This template changed while it was being shown again. Try again.",
  creatorNotApproved: "Publishing to the catalog is invite-only, and this creator key isn't approved yet. Apply from libi's Templates page.",
  creatorNotApprovedRename:
    "Your nickname is on the templates you published, and changing it needs an approved creator key — publishing is invite-only. Apply from libi's Templates page.",
  creatorRequestClosed: "This application was already decided. Email admin@nagellabs.com if you think that's a mistake.",
  badEmail: "That doesn't look like a valid email.",
} as const;

/** The status each code is sent under (the routes' headers in libi-site app/api/templates/**). */
export const FIXTURE_CODE_STATUS: Readonly<Record<PublishErrorCode, number>> = {
  busy: 409,
  nothing_pending: 409,
  wrong_version: 409,
  replay_mismatch: 409,
  upload_changed: 409,
  body_mismatch: 400,
  expired: 410,
  not_found: 404,
  forbidden: 403,
  moderated: 403,
  gone: 410,
  nickname_required: 400,
  creator_not_approved: 403,
  creator_request_closed: 409,
  schema_unsupported: 409,
  code_templates_disabled: 403,
  publishing_paused: 503,
  caps_daily: 429,
  caps_total: 429,
  caps_global: 429,
  unauthorized: 401,
  rate_limited: 429,
  contended: 503,
  invalid: 400,
  internal: 500,
};

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

export const FIXTURE_CLOUD_IDS = ["aaaaaaaaaaaaaaaaaaa2", "bbbbbbbbbbbbbbbbbbb3", "ccccccccccccccccccc4"] as const;
/**
 * A fourth seed, "Launch title" (constants in `left-out-fixture.ts`), whose headline carries two style values this libi does not
 * have — an exit effect it has never heard of and an outline whose colour is not a colour —
 * so applying it answers `leftOut` (lib/templates/author-text.ts). It is the skill-eval
 * `templates/06` fixture: the agent must tell the user what was left out, in libi's
 * neutral words, never the author's values.
 *
 * NOT LISTED: live and installable by id (`get` answers it), but absent from the index, as a
 * template whose listing has not landed yet is on the real site. Listing it would change the
 * Public tab's three-card catalog that e2e/templates-public.spec.ts pins, and it is not in
 * FIXTURE_CLOUD_IDS, which the cloud-source backfill migration names verbatim.
 */
export { FIXTURE_LEFT_OUT_AUTHOR_VALUES, FIXTURE_LEFT_OUT_CLOUD_ID, FIXTURE_LEFT_OUT_NAME, FIXTURE_LEFT_OUT_TAGS };
/** The seeds' author: no creator key hashes to it, so no caller owns them. */
export const FIXTURE_SEED_AUTHOR_ID = "fixture-seed-author";

interface FileEntry {
  name: string;
  bytes: number;
  contentType: string;
  md5: string;
}

/** The site's TemplateDoc, reduced to what a route reads or writes. Times in ms. */
export interface FixtureDoc {
  id: string;
  name: string;
  description: string;
  tags: string[];
  authorId: string;
  nickname: string;
  version: number;
  hasCode: boolean;
  hidden: boolean;
  hiddenByOwner: boolean;
  /** Visible: the entry is not known to be listed yet. Hidden: not known to be removed. */
  indexPending: boolean;
  /** Whether the index lists it (a visible doc whose listing landed). */
  listed: boolean;
  canvas: { width: number; height: number; fps: number };
  duration: number;
  slotCount: number;
  files: FileEntry[];
  example: { video: string; poster: string; durationSec: number; width: number; height: number };
  uses: { total: number; byDay: Record<string, number> };
  reportsResetAt: number | null;
  /** The operator's statement of reasons (set by hand, as in the console); `/mine` shows it only while moderated. */
  moderation?: { reason: ModerationReason; note: string | null; at: number } | null;
  createdAt: number;
  updatedAt: number;
}

export interface FixtureAuthor {
  nickname: string | null;
  templateCount: number;
  publishes: { day: string; count: number };
}

export interface FixturePending {
  templateId: string;
  version: number;
  authorId: string;
  requestSha256: string;
  scaffoldSha256: string;
  instructions: string;
  expiresAt: number;
  /** A commit holds it until then (another commit gets `busy`). */
  claimedUntil: number | null;
  committedAt: number | null;
}

export const FIXTURE_ROUTES = ["index", "get", "prepare", "commit", "use", "report", "mine", "authors_me", "creators_me", "visibility", "upload"] as const;
export type FixtureRoute = (typeof FIXTURE_ROUTES)[number];
/** A code the next matching request answers with; `unindexed` makes the next commit land without its listing (`indexed: false`). */
export interface FixtureFault {
  route: FixtureRoute;
  code: PublishErrorCode | "unindexed";
  times: number;
}

export interface FixtureCatalog {
  entries: Map<string, FixtureDoc>;
  objects: Map<string, { body: Buffer; contentType: string; generation: number }>;
  authors: Map<string, FixtureAuthor>;
  pending: Map<string, FixturePending>;
  reservations: Map<string, { authorId: string; expiresAt: number }>;
  /** Signed upload targets: bucket path → what the signature pins. */
  signed: Map<string, { contentType: string; bytes: number; expiresAt: number }>;
  /** Every counted report, for tests (the site's `reports` record, reduced); `details` is "" when none was sent. */
  reports: Array<{ id: string; reason: ReportReason; details: string; client: string; at: number }>;
  /** Every use notice received (counted or a same-day repeat). */
  uses: Array<{ id: string; client: string; at: number; counted: boolean }>;
  faults: FixtureFault[];
  /** Creator requests by author id (the site's `creatorRequests`); an author with none reads as `LIBI_TEST_CATALOG_CREATOR`. */
  creators: Map<string, "pending" | "approved" | "rejected">;
  generation: number;
  changedAt: number;
}

// One store per process, across module instances (Next dev re-evaluates route modules).
const STORE_KEY = Symbol.for("libi.templatesCatalogFixture");
type Holder = { [STORE_KEY]?: FixtureCatalog };

/** Each seed's poster: its clip's first frame (the vertical one's at 1 s), made once with ffmpeg and inlined — tiny, and present in any install. */
const POSTERS: Readonly<Record<string, Buffer>> = {
  "clip-green-3s.mp4": Buffer.from("/9j/4AAQSkZJRgABAgAAAQABAAD//gAQTGF2YzYyLjI4LjEwMgD/2wBDAAgUFBcUFxsbGxsbGyAeICEhISAgICAhISEkJCQqKiokJCQhISQkKCgqKi4vLisrKisvLzIyMjw8OTlGRkhWVmf/xABMAAEBAAAAAAAAAAAAAAAAAAAABgEBAQAAAAAAAAAAAAAAAAAAAAYQAQAAAAAAAAAAAAAAAAAAAAARAQAAAAAAAAAAAAAAAAAAAAD/wAARCAB4AKADASIAAhEAAxEA/9oADAMBAAIRAxEAPwCLASiJAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAf/2Q==", "base64"),
  "clip-red-3s.mp4": Buffer.from("/9j/4AAQSkZJRgABAgAAAQABAAD//gAQTGF2YzYyLjI4LjEwMgD/2wBDAAgUFBcUFxsbGxsbGyAeICEhISAgICAhISEkJCQqKiokJCQhISQkKCgqKi4vLisrKisvLzIyMjw8OTlGRkhWVmf/xABNAAEBAAAAAAAAAAAAAAAAAAAABgEBAQEAAAAAAAAAAAAAAAAAAAYHEAEAAAAAAAAAAAAAAAAAAAAAEQEAAAAAAAAAAAAAAAAAAAAA/8AAEQgAeACgAwEiAAIRAAMRAP/aAAwDAQACEQMRAD8AiwEm38AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB/9k=", "base64"),
  "vertical-9x16-3s.mp4": Buffer.from("/9j/4AAQSkZJRgABAgAAAQABAAD//gAQTGF2YzYyLjI4LjEwMgD/2wBDAAgUFBcUFxsbGxsbGyAeICEhISAgICAhISEkJCQqKiokJCQhISQkKCgqKi4vLisrKisvLzIyMjw8OTlGRkhWVmf/xABMAAEBAAAAAAAAAAAAAAAAAAAABwEBAQAAAAAAAAAAAAAAAAAAAAUQAQAAAAAAAAAAAAAAAAAAAAARAQAAAAAAAAAAAAAAAAAAAAD/wAARCACgAFoDASIAAhEAAxEA/9oADAMBAAIRAxEAPwCagKyaAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA//2Q==", "base64"),
};
/** When the checkout's clips are absent: a bare ftyp box — an MP4 to every sniff, though it will not play. */
const BARE_MP4 = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftypisom"), Buffer.from([0, 0, 2, 0]), Buffer.from("isomiso2")]);

const md5 = (b: Buffer) => createHash("md5").update(b).digest("base64");
const dayKey = (ms: number) => new Date(ms).toISOString().slice(0, 10).replace(/-/g, "");
const iso = (ms: number) => new Date(ms).toISOString();
const templatePrefix = (id: string, v: number) => `templates/${id}/v${v}/`;
const stagingPrefix = (id: string, v: number) => `tmp/${id}/v${v}/`;
const retiredPrefix = (id: string, v: number) => `retired/${id}/v${v}/`;
const pendingKey = (id: string, v: number) => `${id}/v${v}`;

function bucketBase(): string {
  return catalogBucketBase(TEST_MODE_SOURCE, getCurrentPort());
}

function newTemplateId(): string {
  const bytes = randomBytes(20);
  let out = "";
  for (let i = 0; i < 20; i++) out += ID_ALPHABET[bytes[i] & 31];
  return out;
}

function putObject(f: FixtureCatalog, key: string, body: Buffer, contentType: string): void {
  f.objects.set(key, { body, contentType, generation: ++f.generation });
}

function readClip(name: string): Buffer {
  try {
    return fs.readFileSync(path.resolve(process.cwd(), "__tests__/helpers/fixtures/video", name));
  } catch {
    return BARE_MP4;
  }
}

function seedScaffold(name: string, description: string, tags: string[], canvas: { width: number; height: number }, headlineExtra: Record<string, unknown> = {}): TemplateScaffold {
  const raw = {
    schema: 1,
    name,
    description,
    tags,
    canvas: { ...canvas, fps: 30 },
    duration: 3,
    slots: [{ key: "headline", kind: "text", label: "Headline", required: true }],
    overlays: [
      {
        key: "headline",
        kind: "text",
        displayName: "Headline",
        // A composition's rect is in the canvas's PIXELS, as extract copies it from a
        // piece: the middle 80% x 20% band. (A normalised 0.8 wide wrapped the
        // applied headline one word per line around x = 0.5 px.)
        rect: { x: canvas.width * 0.1, y: canvas.height * 0.4, width: canvas.width * 0.8, height: canvas.height * 0.2 },
        startTime: 0,
        duration: 3,
        z: 1,
        opacity: 1,
        text: { slot: "headline" },
        font: "bold 72px Inter",
        color: "#ffffff",
        align: "center",
        ...headlineExtra,
      },
    ],
    audioClips: [],
    assets: [],
    fonts: [],
    captionStyles: [],
  };
  const parsed = templateScaffoldSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`test fixture seed "${name}" is not a valid scaffold: ${parsed.error.issues[0]?.message}`);
  return parsed.data as unknown as TemplateScaffold;
}

function seed(
  f: FixtureCatalog,
  now: number,
  s: { id: string; name: string; tags: string[]; clip: string; canvas: { width: number; height: number }; example: { width: number; height: number }; ageDays: number; uses: number; listed?: boolean; headlineExtra?: Record<string, unknown> },
): FixtureDoc {
  const description = `${s.name}: a fixture template for test mode.`;
  const scaffold = seedScaffold(s.name, description, s.tags, s.canvas, s.headlineExtra);
  const files: Array<[string, Buffer, string]> = [
    ["template.json", Buffer.from(JSON.stringify(scaffold)), "application/json"],
    ["index.md", Buffer.from(`# Purpose\n${s.name}.\n\n## Slots\n- headline: the text shown.\n\n## Steps\n1. Fill the headline slot.\n`), "text/markdown"],
    ["poster.jpg", POSTERS[s.clip], "image/jpeg"],
    ["example.mp4", readClip(s.clip), "video/mp4"],
  ];
  const live = templatePrefix(s.id, 1);
  for (const [name, body, ct] of files) putObject(f, live + name, body, ct);
  const createdAt = now - s.ageDays * DAY_MS;
  const today = Math.min(s.uses, 3);
  return {
    id: s.id,
    name: s.name,
    description,
    tags: s.tags,
    authorId: FIXTURE_SEED_AUTHOR_ID,
    nickname: "fixture",
    version: 1,
    hasCode: false,
    hidden: false,
    hiddenByOwner: false,
    indexPending: false,
    listed: s.listed ?? true,
    canvas: { ...s.canvas, fps: 30 },
    duration: 3,
    slotCount: 1,
    files: files.map(([name, body, ct]) => ({ name, bytes: body.byteLength, contentType: ct, md5: md5(body) })),
    example: { video: `${live}example.mp4`, poster: `${live}poster.jpg`, durationSec: 3, ...s.example },
    uses: { total: s.uses, byDay: today ? { [dayKey(now)]: today } : {} },
    reportsResetAt: null,
    createdAt,
    updatedAt: createdAt,
  };
}

/** The process-wide store, seeded on first use: three listed templates and the unlisted Launch title. */
export function getFixtureCatalog(): FixtureCatalog {
  const holder = globalThis as Holder;
  const existing = holder[STORE_KEY];
  if (existing) return existing;
  const now = Date.now();
  const f: FixtureCatalog = {
    entries: new Map(),
    objects: new Map(),
    authors: new Map(),
    pending: new Map(),
    reservations: new Map(),
    signed: new Map(),
    reports: [],
    uses: [],
    faults: [],
    creators: new Map(),
    generation: 0,
    changedAt: now,
  };
  const seeds = [
    seed(f, now, { id: FIXTURE_CLOUD_IDS[0], name: "Green hook", tags: ["hook", "green"], clip: "clip-green-3s.mp4", canvas: { width: 1920, height: 1080 }, example: { width: 320, height: 240 }, ageDays: 40, uses: 12 }),
    seed(f, now, { id: FIXTURE_CLOUD_IDS[1], name: "Red caption", tags: ["caption", "red"], clip: "clip-red-3s.mp4", canvas: { width: 1920, height: 1080 }, example: { width: 320, height: 240 }, ageDays: 3, uses: 2 }),
    seed(f, now, { id: FIXTURE_CLOUD_IDS[2], name: "Vertical kinetic caption", tags: ["caption", "kinetic", "vertical"], clip: "vertical-9x16-3s.mp4", canvas: { width: 1080, height: 1920 }, example: { width: 540, height: 960 }, ageDays: 1, uses: 0 }),
    seed(f, now, {
      id: FIXTURE_LEFT_OUT_CLOUD_ID,
      name: FIXTURE_LEFT_OUT_NAME,
      tags: [...FIXTURE_LEFT_OUT_TAGS],
      clip: "clip-green-3s.mp4",
      canvas: { width: 1920, height: 1080 },
      example: { width: 320, height: 240 },
      ageDays: 2,
      uses: 0,
      listed: false,
      headlineExtra: {
        effects: { out: { effectId: FIXTURE_LEFT_OUT_AUTHOR_VALUES.exitEffectId, durationMs: 400 } },
        stroke: { color: FIXTURE_LEFT_OUT_AUTHOR_VALUES.outlineColour, width: 4 },
      },
    }),
  ];
  for (const e of seeds) f.entries.set(e.id, e);
  holder[STORE_KEY] = f;
  return f;
}

export function __resetFixtureCatalogForTests(): void {
  delete (globalThis as Holder)[STORE_KEY];
}

/** The next `times` requests to `route` answer `code` (with the site's status, and Retry-After where the site sends one). */
export function injectFixtureFault(fault: { route: FixtureRoute; code: FixtureFault["code"]; times?: number }): void {
  getFixtureCatalog().faults.push({ route: fault.route, code: fault.code, times: fault.times ?? 1 });
}

/** Faults a route answers at a particular step (as the site does) rather than up front. */
const IN_FLOW_FAULTS: ReadonlySet<FixtureFault["code"]> = new Set(["unindexed", "upload_changed"]);

function takeFault(f: FixtureCatalog, route: FixtureRoute, code?: FixtureFault["code"]): FixtureFault["code"] | null {
  const i = f.faults.findIndex((x) => x.route === route && (code === undefined ? !IN_FLOW_FAULTS.has(x.code) : x.code === code));
  if (i < 0) return null;
  const hit = f.faults[i];
  hit.times -= 1;
  if (hit.times <= 0) f.faults.splice(i, 1);
  return hit.code;
}

function changed(f: FixtureCatalog): void {
  f.changedAt = Math.max(Date.now(), f.changedAt + 1);
}

// ---------------------------------------------------------------------------
// Replies
// ---------------------------------------------------------------------------

export type FixtureReply = { status: number; headers: Record<string, string>; body: Buffer };

const EMPTY = Buffer.alloc(0);
const NOT_FOUND: FixtureReply = { status: 404, headers: {}, body: EMPTY };
const OPEN = { "Access-Control-Allow-Origin": "*" } as const;

function json(status: number, body: unknown, extra: Record<string, string> = {}): FixtureReply {
  return { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...extra }, body: Buffer.from(JSON.stringify(body)) };
}

class Refusal {
  constructor(
    readonly status: number,
    readonly error: string,
    readonly code: PublishErrorCode,
    readonly extra: Record<string, string> = {},
  ) {}
}

const refuse = (code: PublishErrorCode, error: string) => new Refusal(FIXTURE_CODE_STATUS[code], error, code);

/** A code as the site sends it when it is injected: its status, its fixed message where it has one, Retry-After where the site sets it. */
/** The version an injected wrong_version names: the one after what the body's template is at (1 for a first publish). */
function faultExpectedVersion(f: FixtureCatalog, body: Buffer, headers: Record<string, string>): number {
  try {
    const id = asObject(readJson(body, headers, PREPARE_BODY_CAP)).templateId;
    return (typeof id === "string" ? (f.entries.get(id)?.version ?? 0) : 0) + 1;
  } catch {
    return 1;
  }
}

function faultRefusal(code: PublishErrorCode, expectedVersion = 1, route?: FixtureRoute): Refusal {
  const words: Partial<Record<PublishErrorCode, string>> = {
    busy: MSG.busy,
    nothing_pending: MSG.nothingPending,
    wrong_version: `Expected version ${expectedVersion}; run prepare again.`,
    replay_mismatch: MSG.alreadyPublished,
    upload_changed: MSG.uploadChanged,
    body_mismatch: MSG.bodyMismatch,
    expired: MSG.expired,
    not_found: MSG.noSuchTemplate,
    forbidden: MSG.notYours,
    moderated: MSG.moderatedPublish,
    gone: MSG.unhideGone,
    nickname_required: MSG.nicknameFirst,
    creator_not_approved: MSG.creatorNotApproved,
    creator_request_closed: MSG.creatorRequestClosed,
    schema_unsupported: MSG.unsupportedSchema,
    code_templates_disabled: CODE_TEMPLATES_BLOCKED_ERROR,
    publishing_paused: MSG.publishingPaused,
    caps_daily: MSG.dailyCap,
    caps_total: MSG.totalCap,
    // The site sends the prepares cap from prepare and the new-templates cap from commit (prepare checks both).
    caps_global: route === "prepare" ? MSG.globalPreparesCap : MSG.globalNewCap,
    unauthorized: MSG.unauthorized,
    rate_limited: MSG.rateLimited,
    contended: MSG.contended,
    invalid: "The request is invalid.",
    internal: MSG.internal,
  };
  const extra: Record<string, string> =
    code === "rate_limited" ? { "Retry-After": String(RATE_WINDOW_S) } : code === "contended" ? { "Retry-After": String(CONTENDED_RETRY_AFTER_S) } : {};
  return new Refusal(FIXTURE_CODE_STATUS[code], words[code] ?? MSG.internal, code, extra);
}

function refusalReply(r: Refusal, open: boolean): FixtureReply {
  return json(r.status, { ok: false, error: r.error, code: r.code }, { ...(open ? OPEN : {}), ...r.extra });
}

// ---------------------------------------------------------------------------
// Request reading (lib/templates/http.ts)
// ---------------------------------------------------------------------------

function header(headers: Record<string, string>, name: string): string | null {
  const want = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) if (k.toLowerCase() === want) return v;
  return null;
}

/** `requireAuthor`: the author a well-formed bearer proves, or a 401. */
function requireAuthor(headers: Record<string, string>): string {
  const h = header(headers, "authorization");
  const m = h ? /^Bearer\s+(\S+)$/.exec(h.trim()) : null;
  if (!m || !CREATOR_KEY_PATTERN.test(m[1])) throw refuse("unauthorized", MSG.unauthorized);
  return createHash("sha256").update(m[1]).digest("base64url");
}

/** `readJsonBody`: JSON content type, under the cap, UTF-8, parseable. */
function readJson(body: Buffer, headers: Record<string, string>, cap: number): unknown {
  const ct = header(headers, "content-type");
  if (ct === null || ct.split(";")[0].trim().toLowerCase() !== "application/json") throw new Refusal(415, "Send the body as Content-Type: application/json.", "invalid");
  if (body.byteLength > cap) throw new Refusal(413, "Request body is too large.", "invalid");
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(body);
  } catch {
    throw refuse("invalid", "Request body is not valid UTF-8.");
  }
  try {
    return JSON.parse(text);
  } catch {
    throw refuse("invalid", "Expected a JSON body.");
  }
}

function asObject(v: unknown): Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) throw refuse("invalid", "Expected a JSON object.");
  return v as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// The publish gate (lib/templates/prepare.ts#parsePrepare)
// ---------------------------------------------------------------------------

interface PublishRequest {
  templateId: string | null;
  name: string;
  description: string;
  tags: string[];
  scaffold: TemplateScaffold;
  instructions: string;
  files: FileEntry[];
  example: { durationSec: number; width: number; height: number };
  hasCode: boolean;
}

const MD5_PATTERN = /^[A-Za-z0-9+/]{22}==$/;
const FIXED_FILES = ["template.json", "index.md", "poster.jpg", "example.mp4"] as const;

function normaliseTag(t: string): string {
  return t.trim().replace(/[A-Z]+/g, (m) => m.toLowerCase());
}

function readName(raw: unknown): string {
  const name = typeof raw === "string" ? raw.trim() : "";
  if (!name || name.length > MAX_NAME) throw refuse("invalid", `name is required and at most ${MAX_NAME} characters.`);
  const problem = singleLineTextProblem(name);
  if (problem) throw refuse("invalid", `name ${problem}.`);
  if (visibleCharCount(name) < MIN_VISIBLE_NAME_CHARS) throw refuse("invalid", `name needs at least ${MIN_VISIBLE_NAME_CHARS} visible characters (letters or digits).`);
  const edge = edgeTextProblem(name);
  if (edge) throw refuse("invalid", `name ${edge}.`);
  return name;
}

function readDescription(raw: unknown): string {
  if (typeof raw !== "string") throw refuse("invalid", "description must be a string.");
  const description = raw.trim();
  if (description.length > MAX_DESCRIPTION) throw refuse("invalid", `description is at most ${MAX_DESCRIPTION} characters.`);
  const problem = multiLineTextProblem(description) ?? edgeTextProblem(description);
  if (problem) throw refuse("invalid", `description ${problem}.`);
  return description;
}

function readTags(raw: unknown): string[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw refuse("invalid", "tags must be an array.");
  if (raw.length > MAX_TAGS) throw refuse("invalid", `tags: at most ${MAX_TAGS}.`);
  const out: string[] = [];
  for (const t of raw) {
    if (typeof t !== "string") throw refuse("invalid", "tags must be strings.");
    const tag = normaliseTag(t);
    if (!TAG_PATTERN.test(tag)) throw refuse("invalid", "a tag must match ^[a-z0-9][a-z0-9-]{0,29}$.");
    out.push(tag);
  }
  return [...new Set(out)];
}

function assetExtension(name: string): string | null {
  if (!name.startsWith("assets/")) return null;
  const base = name.slice("assets/".length);
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(base) || base.includes("..")) return null;
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1) : null;
}

/** Every refusal in the site's order, the first one thrown: 409 handshake, 403 code, 400 the rest. */
function parsePublish(body: unknown): PublishRequest {
  const schemaHash = typeof body === "object" && body !== null ? (body as Record<string, unknown>).schemaHash : undefined;
  if (schemaHash !== SCAFFOLD_SCHEMA_SHA256) throw refuse("schema_unsupported", MSG.unsupportedSchema);
  if (Array.isArray(body)) throw refuse("invalid", "Expected a JSON object.");
  const r = body as Record<string, unknown>;

  let templateId: string | null = null;
  if (r.templateId !== undefined) {
    if (typeof r.templateId !== "string" || !CLOUD_ID_PATTERN.test(r.templateId)) throw refuse("invalid", "templateId must be a 20-char catalog id.");
    templateId = r.templateId;
  }
  const name = readName(r.name);
  const description = readDescription(r.description === undefined ? "" : r.description);
  const tags = readTags(r.tags);

  const parsed = templateScaffoldSchema.safeParse(r.scaffold);
  if (!parsed.success) throw refuse("invalid", `scaffold is invalid: ${parsed.error.issues[0]?.message ?? "schema"}`);
  const scaffold = parsed.data as unknown as TemplateScaffold;
  const valueProblem = scaffoldValueProblems(scaffold)[0];
  if (valueProblem) throw refuse("invalid", valueProblem);
  if (scaffold.name !== name) throw refuse("invalid", "scaffold.name must equal name exactly (trimmed).");
  if (scaffold.description !== description) throw refuse("invalid", "scaffold.description must equal description exactly (trimmed).");
  const scaffoldTags = new Set(scaffold.tags.map(normaliseTag));
  if (scaffoldTags.size !== tags.length || !tags.every((t) => scaffoldTags.has(t))) throw refuse("invalid", "scaffold.tags must equal tags.");

  if (typeof r.instructions !== "string") throw refuse("invalid", "instructions (index.md) must be a string.");
  const instructions = r.instructions;
  if (Buffer.byteLength(instructions, "utf8") > CAPS.instructions) throw refuse("invalid", "index.md is at most 32 KB.");
  const instructionsProblem = multiLineTextProblem(instructions);
  if (instructionsProblem) throw refuse("invalid", `instructions (index.md) ${instructionsProblem}.`);

  const hasCode = hasCodeIn(scaffold);
  if (hasCode && !PUBLIC_CODE_TEMPLATES) throw refuse("code_templates_disabled", CODE_TEMPLATES_BLOCKED_ERROR);

  for (const asset of scaffold.assets) {
    if ((asset.kind === "video" || asset.kind === "audio") && asset.url === undefined) throw refuse("invalid", `asset "${asset.ref}" is ${asset.kind} and must be a hosted url, not a file.`);
    const urlProblem = asset.url === undefined ? null : hostedUrlProblem(asset.url);
    if (urlProblem) throw refuse("invalid", `asset "${asset.ref}" url ${urlProblem}.`);
  }
  const declared = new Set<string>();
  for (const asset of scaffold.assets) {
    if (asset.file === undefined) continue;
    const ext = assetExtension(asset.file);
    const fits = ext !== null && (asset.kind === "image" ? (IMAGE_EXTS as readonly string[]).includes(ext) : asset.kind === "font" && (FONT_EXTS as readonly string[]).includes(ext));
    if (!fits) throw refuse("invalid", `asset "${asset.ref}" names a file that is not an allowed name.`);
    declared.add(asset.file);
  }
  for (const overlay of scaffold.overlays) if (overlay.codeFile !== undefined) declared.add(overlay.codeFile);

  if (!Array.isArray(r.files)) throw refuse("invalid", "files must be an array.");
  if (r.files.length > MAX_FILES) throw refuse("invalid", `At most ${MAX_FILES} files.`);
  const files: FileEntry[] = [];
  const seen = new Set<string>();
  let total = 0;
  for (const raw of r.files as unknown[]) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw refuse("invalid", "files entries must be objects.");
    const e = raw as Record<string, unknown>;
    if (typeof e.name !== "string") throw refuse("invalid", "file name is required.");
    const ct = contentTypeForName(e.name);
    const cap = capForName(e.name);
    if (!ct || !cap) throw refuse("invalid", "a file is not an allowed name.");
    if (seen.has(e.name)) throw refuse("invalid", `file "${e.name}" may appear only once.`);
    seen.add(e.name);
    if (typeof e.bytes !== "number" || !Number.isSafeInteger(e.bytes) || e.bytes < 0 || Object.is(e.bytes, -0)) throw refuse("invalid", `file "${e.name}": bytes must be a non-negative integer.`);
    if (e.contentType !== ct) throw refuse("invalid", `file "${e.name}" must be uploaded as ${ct}.`);
    if (typeof e.md5 !== "string" || !MD5_PATTERN.test(e.md5)) throw refuse("invalid", `file "${e.name}": md5 must be the base64 digest.`);
    if (e.bytes > cap.cap) throw refuse("invalid", `file "${e.name}" is too large (${cap.label}).`);
    total += e.bytes;
    files.push({ name: e.name, bytes: e.bytes, contentType: ct, md5: e.md5 });
  }
  if (total > CAPS.total) throw refuse("invalid", "All files together are at most 24 MB.");
  for (const required of FIXED_FILES) if (!seen.has(required)) throw refuse("invalid", `file "${required}" is required.`);
  for (const f of files) {
    if (!(FIXED_FILES as readonly string[]).includes(f.name) && !declared.has(f.name)) throw refuse("invalid", `file "${f.name}" is not declared by the scaffold.`);
  }
  for (const d of declared) if (!seen.has(d)) throw refuse("invalid", `file "${d}" is declared by the scaffold but missing from files.`);

  const ex = r.example;
  const bad = () => refuse("invalid", "example needs durationSec, width and height.");
  if (typeof ex !== "object" || ex === null || Array.isArray(ex)) throw bad();
  const { durationSec, width, height } = ex as Record<string, unknown>;
  if (typeof durationSec !== "number" || typeof width !== "number" || typeof height !== "number") throw bad();
  if (!Number.isFinite(durationSec) || !Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0) throw bad();
  if (durationSec < EXAMPLE_MIN_SECONDS) throw refuse("invalid", `example.mp4 is at least ${EXAMPLE_MIN_SECONDS} seconds.`);
  if (durationSec > EXAMPLE_MAX_SECONDS) throw refuse("invalid", `example.mp4 is at most ${EXAMPLE_MAX_SECONDS} seconds.`);
  if (Math.max(width, height) > EXAMPLE_MAX_LONG_EDGE) throw refuse("invalid", `example.mp4 is at most ${EXAMPLE_MAX_LONG_EDGE} px on the long edge.`);

  return { templateId, name, description, tags, scaffold, instructions, files, example: { durationSec, width, height }, hasCode };
}

// ---------------------------------------------------------------------------
// Canonical JSON and the commit-time checks (lib/templates/verify.ts)
// ---------------------------------------------------------------------------

/** One JSON text per JSON value: keys sorted at every depth, no whitespace. Throws on a non-JSON value. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("canonicalJson: non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${Array.from(value, (v) => (v === undefined ? "null" : canonicalJson(v))).join(",")}]`;
  if (typeof value === "object") {
    const rec = value as Record<string, unknown>;
    const keys = Object.keys(rec)
      .filter((k) => rec[k] !== undefined)
      .sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(rec[k])}`).join(",")}}`;
  }
  throw new TypeError(`canonicalJson: ${typeof value} is not a JSON value`);
}

const sha256Hex = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

/** publish.ts#requestSha256: the whole validated request but templateId (and the already-checked schemaHash). */
function requestSha256(p: PublishRequest): string {
  const { templateId: _templateId, ...bound } = p;
  void _templateId;
  return sha256Hex(canonicalJson(bound));
}

/** Why the staged objects are not exactly what prepare validated, or null. */
function stagedProblem(f: FixtureCatalog, staging: string, files: FileEntry[], pending: FixturePending): string | null {
  const present = new Map([...f.objects].filter(([k]) => k.startsWith(staging)).map(([k, o]) => [k.slice(staging.length), o]));
  const declared = new Set(files.map((x) => x.name));
  for (const name of present.keys()) if (!declared.has(name)) return `object "${name}" was uploaded but not declared`;
  for (const x of files) {
    const obj = present.get(x.name);
    if (!obj) return `file "${x.name}" is missing from the upload`;
    if (obj.body.byteLength !== x.bytes) return `file "${x.name}" size ${obj.body.byteLength} differs from the declared ${x.bytes}`;
    if (md5(obj.body) !== x.md5) return `file "${x.name}" md5 differs from the declared one`;
    if (x.name === "example.mp4" && !(obj.body.byteLength >= 8 && obj.body.subarray(4, 8).toString("latin1") === "ftyp")) return "example.mp4 has no ftyp box — not an MP4";
    if (x.name === "poster.jpg" && !(obj.body[0] === 0xff && obj.body[1] === 0xd8 && obj.body[2] === 0xff)) return "poster.jpg is not a JPEG";
    if (/^(template\.json|index\.md|overlays\/[^/]+\/(draw|scene)\.jsx)$/.test(x.name)) {
      const problem = textFileProblem(x.name, obj.body);
      if (problem) return problem;
    }
    if (x.name === "template.json") {
      let raw: unknown;
      try {
        raw = JSON.parse(obj.body.toString("utf8"));
      } catch {
        return "template.json is not valid JSON";
      }
      const parsed = templateScaffoldSchema.safeParse(raw);
      const notIt = "template.json is not the scaffold that was validated at prepare";
      if (!parsed.success) return `${notIt} (it fails the scaffold schema)`;
      try {
        if (canonicalJson(raw) !== canonicalJson(parsed.data)) return `${notIt} (it carries keys or values the schema drops)`;
        if (sha256Hex(canonicalJson(raw)) !== pending.scaffoldSha256) return notIt;
      } catch {
        return "template.json could not be verified";
      }
    }
    if (x.name === "index.md" && !obj.body.equals(Buffer.from(pending.instructions, "utf8"))) return "index.md is not the instructions that were validated at prepare";
  }
  return null;
}

// ---------------------------------------------------------------------------
// Shapes (lib/templates/shape.ts, index-patch.ts)
// ---------------------------------------------------------------------------

function uses7d(byDay: Record<string, number>, now: number): number {
  let sum = 0;
  for (let i = 0; i < 7; i++) sum += byDay[dayKey(now - i * DAY_MS)] ?? 0;
  return sum;
}

function pruneByDay(byDay: Record<string, number>, now: number): Record<string, number> {
  const floor = dayKey(now - (BYDAY_KEEP_DAYS - 1) * DAY_MS);
  return Object.fromEntries(Object.entries(byDay).filter(([k]) => k >= floor));
}

const isModerated = (d: Pick<FixtureDoc, "hidden" | "hiddenByOwner">) => d.hidden && !d.hiddenByOwner;

function shapePublic(d: FixtureDoc, base: string, now: number) {
  return {
    id: d.id,
    name: d.name,
    description: d.description,
    tags: [...d.tags],
    nickname: d.nickname,
    authorId: d.authorId,
    version: d.version,
    hasCode: d.hasCode,
    canvas: { ...d.canvas },
    duration: d.duration,
    slotCount: d.slotCount,
    files: d.files.map((x) => ({ ...x })),
    prefix: templatePrefix(d.id, d.version),
    base,
    poster: d.example.poster,
    video: d.example.video,
    example: { durationSec: d.example.durationSec, width: d.example.width, height: d.example.height },
    usesTotal: d.uses.total,
    uses7d: uses7d(d.uses.byDay, now),
    createdAt: iso(d.createdAt),
    updatedAt: iso(d.updatedAt),
  };
}

function shapeMine(d: FixtureDoc, base: string, now: number) {
  const moderation = isModerated(d) && d.moderation ? { reason: d.moderation.reason, note: d.moderation.note, at: iso(d.moderation.at) } : null;
  return { ...shapePublic(d, base, now), hidden: d.hidden, moderated: isModerated(d), indexPending: d.indexPending, byDay: pruneByDay(d.uses.byDay, now), moderation };
}

function indexEntry(d: FixtureDoc, now: number, heatAt: number) {
  const heat = uses7d(d.uses.byDay, now);
  return {
    id: d.id,
    name: d.name,
    description: d.description,
    tags: [...d.tags],
    nickname: d.nickname,
    authorId: d.authorId,
    version: d.version,
    hasCode: d.hasCode,
    canvas: { width: d.canvas.width, height: d.canvas.height },
    duration: d.duration,
    slotCount: d.slotCount,
    poster: d.example.poster,
    video: d.example.video,
    usesTotal: d.uses.total,
    uses7d: heat,
    heat,
    heatAt,
    createdAt: iso(d.createdAt),
    updatedAt: iso(d.updatedAt),
  };
}

// ---------------------------------------------------------------------------
// Bucket moves (hide, unhide, retire)
// ---------------------------------------------------------------------------

function moveTree(f: FixtureCatalog, from: string, to: string): void {
  for (const [k, o] of [...f.objects]) {
    if (!k.startsWith(from)) continue;
    f.objects.delete(k);
    putObject(f, to + k.slice(from.length), o.body, o.contentType);
  }
}

function deleteTree(f: FixtureCatalog, prefix: string): void {
  for (const k of [...f.objects.keys()]) if (k.startsWith(prefix)) f.objects.delete(k);
}

/** A hide by `by`: out of the index, every version's files to retired/. Moderation outranks the owner. */
function hide(f: FixtureCatalog, d: FixtureDoc, by: "owner" | "moderation", now: number): void {
  if (!d.hidden) {
    d.hidden = true;
    d.hiddenByOwner = by === "owner";
    d.updatedAt = Math.max(now, d.updatedAt + 1);
  } else if (by === "moderation") {
    d.hiddenByOwner = false;
  }
  d.listed = false;
  for (let v = 1; v <= d.version; v++) moveTree(f, templatePrefix(d.id, v), retiredPrefix(d.id, v));
  d.indexPending = false;
  changed(f);
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

function nickname(raw: unknown): string {
  if (typeof raw !== "string") throw refuse("invalid", "nickname must be a string.");
  const trimmed = raw.trim();
  const problem = singleLineTextProblem(trimmed) ?? edgeTextProblem(trimmed);
  if (problem) throw refuse("invalid", `nickname ${problem}.`);
  const n = trimmed.replace(/ {2,}/g, " ");
  if (!NICKNAME_PATTERN.test(n)) throw refuse("invalid", "nickname is 2 to 32 letters, digits, spaces, - or _.");
  if (!/[A-Za-z0-9]/.test(n)) throw refuse("invalid", "nickname needs at least one letter or digit.");
  return n;
}

function authorOf(f: FixtureCatalog, authorId: string): FixtureAuthor {
  let a = f.authors.get(authorId);
  if (!a) f.authors.set(authorId, (a = { nickname: null, templateCount: 0, publishes: { day: "", count: 0 } }));
  return a;
}

function routeIndex(f: FixtureCatalog, headers: Record<string, string>, now: number): FixtureReply {
  // Stamped with the last change, not the request time, so equal bytes carry an equal ETag (the site's is the object generation).
  const entries = [...f.entries.values()].filter((d) => !d.hidden && d.listed).map((d) => indexEntry(d, now, f.changedAt));
  const at = iso(f.changedAt);
  const body = JSON.stringify({ schema: 1, generatedAt: at, usageRefreshedAt: at, base: bucketBase(), entries });
  const etag = `"${createHash("sha256").update(body).digest("hex").slice(0, 16)}"`;
  const common = { ...OPEN, ETag: etag, "Cache-Control": "public, s-maxage=300, stale-while-revalidate=600" };
  const inm = header(headers, "if-none-match");
  if (inm !== null && (inm.trim() === "*" || inm.split(",").some((t) => t.trim().replace(/^W\//, "") === etag))) return { status: 304, headers: common, body: EMPTY };
  const gz = gzipSync(body);
  return { status: 200, headers: { ...common, "Content-Type": "application/json", "Content-Encoding": "gzip", "Content-Length": String(gz.byteLength) }, body: gz };
}

function routeGet(f: FixtureCatalog, id: string, now: number): FixtureReply {
  const d = f.entries.get(id);
  if (!d || d.hidden) throw refuse("not_found", MSG.noSuchTemplate);
  return json(200, { ok: true, template: shapePublic(d, bucketBase(), now) }, { ...OPEN, "Cache-Control": "public, s-maxage=60, stale-while-revalidate=120" });
}

/** Every author's status until the fixture stores one: LIBI_TEST_CATALOG_CREATOR (skill-eval's `catalogCreator:`), default approved. */
function creatorStatusOf(f: FixtureCatalog, authorId: string): CreatorStatus {
  const stored = f.creators.get(authorId);
  if (stored) return stored;
  const env = process.env.LIBI_TEST_CATALOG_CREATOR;
  return env === "none" || env === "pending" || env === "rejected" ? env : "approved";
}

/** The site's invite-only gate (lib/templates/creators.ts#isApprovedCreator): anyone but an approved creator is refused. */
function requireApproved(f: FixtureCatalog, authorId: string): void {
  if (creatorStatusOf(f, authorId) !== "approved") throw refuse("creator_not_approved", MSG.creatorNotApproved);
}

function routePrepare(f: FixtureCatalog, authorId: string, body: unknown, now: number): { reply: FixtureReply; input: Record<string, unknown> } {
  const p = parsePublish(body);
  const author = authorOf(f, authorId);
  // The site's order: pause → parse → author → the invite-only gate → nickname.
  requireApproved(f, authorId);
  if (!author.nickname) throw refuse("nickname_required", MSG.nicknameFirst);
  let existing: FixtureDoc | null = null;
  let reserved = false;
  if (p.templateId !== null) {
    existing = f.entries.get(p.templateId) ?? null;
    if (existing) {
      if (existing.authorId !== authorId) throw refuse("forbidden", MSG.notYours);
      if (isModerated(existing)) throw refuse("moderated", MSG.moderatedPublish);
    } else {
      const r = f.reservations.get(p.templateId);
      if (!r || now >= r.expiresAt) throw refuse("not_found", MSG.noSuchTemplateId);
      if (r.authorId !== authorId) throw refuse("forbidden", MSG.notYours);
      reserved = true;
    }
  }
  const count = author.publishes.day === dayKey(now) ? author.publishes.count : 0;
  if (count >= MAX_PUBLISHES_PER_DAY) throw refuse("caps_daily", MSG.dailyCap);
  if (!existing && author.templateCount >= MAX_TEMPLATES_PER_AUTHOR) throw refuse("caps_total", MSG.totalCap);

  const templateId = existing?.id ?? p.templateId ?? newTemplateId();
  const version = existing ? existing.version + 1 : 1;
  const key = pendingKey(templateId, version);
  const prior = f.pending.get(key);
  // pending.ts#mayReplace: never over a record a commit holds, or a receipt still kept.
  if (prior && ((prior.claimedUntil !== null && prior.claimedUntil > now) || (prior.committedAt !== null && prior.expiresAt > now))) throw refuse("busy", MSG.busy);
  f.pending.set(key, {
    templateId,
    version,
    authorId,
    requestSha256: requestSha256(p),
    scaffoldSha256: sha256Hex(canonicalJson(p.scaffold)),
    instructions: p.instructions,
    expiresAt: now + PENDING_PUBLISH_TTL_MS,
    claimedUntil: null,
    committedAt: null,
  });
  if (!existing) f.reservations.set(templateId, { authorId, expiresAt: now + RESERVATION_KEEP_MS });
  const staging = stagingPrefix(templateId, version);
  if (existing || reserved) deleteTree(f, staging);
  const expiresAt = now + SIGNED_URL_TTL_MS;
  const base = bucketBase();
  const uploads = p.files.map((x) => {
    f.signed.set(staging + x.name, { contentType: x.contentType, bytes: x.bytes, expiresAt });
    const headers: Record<string, string> = { "Content-Type": x.contentType, "x-goog-content-length-range": `0,${x.bytes}` };
    if (x.name.endsWith(".svg")) headers["Content-Disposition"] = "attachment";
    return { name: x.name, url: `${base}${staging}${x.name}`, headers };
  });
  return {
    reply: json(200, { ok: true, templateId, version, uploads, expiresAt: iso(expiresAt) }),
    input: { templateId, version, name: p.name, files: p.files.map((x) => x.name) },
  };
}

/** The listing lands (or, under an `unindexed` fault, does not): what `indexed` answers. */
function settleListing(f: FixtureCatalog, d: FixtureDoc): boolean {
  if (d.hidden) return true;
  if (takeFault(f, "commit", "unindexed")) {
    d.indexPending = true;
    return false;
  }
  if (d.version > 1) moveTree(f, templatePrefix(d.id, d.version - 1), retiredPrefix(d.id, d.version - 1));
  d.listed = true;
  d.indexPending = false;
  changed(f);
  return true;
}

function routeCommit(f: FixtureCatalog, authorId: string, body: unknown, now: number): { reply: FixtureReply; input: Record<string, unknown> } {
  const p = parsePublish(body);
  const version = (body as Record<string, unknown>).version;
  if (p.templateId === null || typeof version !== "number" || !Number.isSafeInteger(version) || version < 1) throw refuse("invalid", MSG.commitIds);
  const id = p.templateId;
  const input = { templateId: id, version };
  const author = authorOf(f, authorId);
  requireApproved(f, authorId);
  if (!author.nickname) throw refuse("nickname_required", MSG.nicknameFirst);
  const owner = f.entries.get(id)?.authorId;
  if (owner !== undefined && owner !== authorId) throw refuse("forbidden", MSG.notYours);

  const key = pendingKey(id, version);
  const pending = f.pending.get(key);
  if (!pending || (pending.committedAt !== null && pending.expiresAt <= now)) throw refuse("nothing_pending", MSG.nothingPending);
  if (pending.authorId !== authorId) throw refuse("forbidden", MSG.notYours);
  if (pending.claimedUntil !== null && pending.claimedUntil > now) throw refuse("busy", MSG.busy);
  const staging = stagingPrefix(id, version);

  // A replay of a commit that succeeded: the same success for the same body only.
  if (pending.committedAt !== null) {
    if (requestSha256(p) !== pending.requestSha256) throw refuse("replay_mismatch", MSG.alreadyPublished);
    const doc = f.entries.get(id);
    const indexed = !doc || doc.version !== version || doc.listed || doc.hidden || settleListing(f, doc);
    return { reply: json(200, { ok: true, templateId: id, version, indexed }), input: { ...input, replay: true } };
  }
  if (now >= pending.expiresAt) {
    f.pending.delete(key);
    deleteTree(f, staging);
    throw refuse("expired", MSG.expired);
  }

  // Under the claim: every refusal from here deletes the record and the staging.
  const settleRefusal = (r: Refusal): never => {
    f.pending.delete(key);
    deleteTree(f, staging);
    throw r;
  };
  const prior = f.entries.get(id) ?? null;
  if (prior && isModerated(prior)) settleRefusal(refuse("moderated", MSG.moderatedPublish));
  const expected = prior ? prior.version + 1 : 1;
  if (version !== expected) settleRefusal(new Refusal(409, `Expected version ${expected}; run prepare again.`, "wrong_version"));
  if (requestSha256(p) !== pending.requestSha256) settleRefusal(refuse("body_mismatch", MSG.bodyMismatch));
  const problem = stagedProblem(f, staging, p.files, pending);
  if (problem) settleRefusal(refuse("invalid", problem));
  if (takeFault(f, "commit", "upload_changed")) settleRefusal(refuse("upload_changed", MSG.uploadChanged));
  // bumpAuthorPublish: the atomic cap check.
  const today = dayKey(now);
  const count = author.publishes.day === today ? author.publishes.count : 0;
  if (count >= MAX_PUBLISHES_PER_DAY) settleRefusal(refuse("caps_daily", MSG.dailyCap));
  if (!prior && author.templateCount >= MAX_TEMPLATES_PER_AUTHOR) settleRefusal(refuse("caps_total", MSG.totalCap));
  author.publishes = { day: today, count: count + 1 };
  if (!prior) author.templateCount += 1;

  const live = templatePrefix(id, version);
  for (const x of p.files) {
    const o = f.objects.get(staging + x.name)!;
    putObject(f, live + x.name, o.body, o.contentType);
  }
  deleteTree(f, staging);
  const fields = {
    name: p.name,
    description: p.description,
    tags: p.tags,
    nickname: author.nickname!,
    version,
    hasCode: p.hasCode,
    canvas: { width: p.scaffold.canvas.width, height: p.scaffold.canvas.height, fps: p.scaffold.canvas.fps },
    duration: p.scaffold.duration,
    slotCount: p.scaffold.slots.length,
    files: p.files,
    example: { video: `${live}example.mp4`, poster: `${live}poster.jpg`, ...p.example },
    updatedAt: now,
  };
  let doc: FixtureDoc;
  if (prior) {
    // A republish writes only what a publish owns: usage, reports, hidden and createdAt stay.
    Object.assign(prior, fields, { indexPending: prior.hidden ? prior.indexPending : true });
    doc = prior;
  } else {
    doc = { ...fields, id, authorId, hidden: false, hiddenByOwner: false, indexPending: true, listed: false, uses: { total: 0, byDay: {} }, reportsResetAt: null, createdAt: now };
    f.entries.set(id, doc);
  }
  pending.committedAt = now;
  pending.claimedUntil = null;
  pending.expiresAt = now + COMMITTED_KEEP_MS;
  if (version === 1) f.reservations.delete(id);
  const indexed = settleListing(f, doc);
  return { reply: json(200, { ok: true, templateId: id, version, indexed }), input };
}

function routeUse(f: FixtureCatalog, id: string, client: string, now: number): FixtureReply {
  const d = f.entries.get(id);
  if (!d || d.hidden) throw refuse("not_found", MSG.noSuchTemplate);
  const day = dayKey(now);
  // Counted once per (template, UTC day, client); a repeat is answered alike.
  const counted = !f.uses.some((u) => u.id === id && u.client === client && u.counted && dayKey(u.at) === day);
  f.uses.push({ id, client, at: now, counted });
  if (counted) {
    d.uses.total += 1;
    d.uses.byDay[day] = (d.uses.byDay[day] ?? 0) + 1;
    changed(f);
  }
  return json(200, { ok: true });
}

/** libi-site lib/templates/reports.ts#parseDetails (optional, as the app route reads it), messages verbatim. */
function reportDetails(raw: unknown): string {
  if (raw === undefined || raw === null) return "";
  if (typeof raw !== "string") throw refuse("invalid", "details must be text.");
  const details = raw.trim();
  if (details.length > REPORT_DETAILS_MAX) throw refuse("invalid", `details: at most ${REPORT_DETAILS_MAX} characters.`);
  const problem = details ? multiLineTextProblem(details) : null;
  if (problem) throw refuse("invalid", `details ${problem}.`);
  return details;
}

function routeReport(f: FixtureCatalog, id: string, reason: ReportReason, details: string, client: string, now: number): FixtureReply {
  const d = f.entries.get(id);
  // No such template reads exactly as a hidden one.
  if (!d) return json(200, { ok: true, hidden: true });
  const live = f.reports.filter((r) => r.id === id && now - r.at < REPORT_WINDOW_MS);
  if (!live.some((r) => r.client === client)) {
    f.reports.push({ id, reason, details, client, at: now });
    if (isModerated(d)) d.reportsResetAt = now;
    else {
      const inWindow = live.filter((r) => d.reportsResetAt === null || r.at > d.reportsResetAt).length + 1;
      if (inWindow >= AUTO_HIDE_REPORTS) {
        hide(f, d, "moderation", now);
        d.reportsResetAt = now;
        // Its statement of reasons, as the site writes it (shape.ts#recordReport): hidden after reports, pending review.
        d.moderation = { reason: "reports", note: null, at: now };
      }
    }
  }
  return json(200, { ok: true, hidden: d.hidden });
}

function routeMine(f: FixtureCatalog, authorId: string, now: number): FixtureReply {
  const base = bucketBase();
  const templates = [...f.entries.values()]
    .filter((d) => d.authorId === authorId)
    .sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? -1 : 1))
    .map((d) => shapeMine(d, base, now));
  return json(200, { ok: true, nickname: f.authors.get(authorId)?.nickname ?? null, templates });
}

/**
 * The site's rename gate (lib/templates/creators.ts#mayRename): the nickname
 * is on every template the author published, so an author who is not
 * approved and owns any template — hidden or not — is refused 403
 * creator_not_approved, nothing written. Checked after the nickname parses,
 * as the site does.
 */
function mayRename(f: FixtureCatalog, authorId: string): boolean {
  if (creatorStatusOf(f, authorId) === "approved") return true;
  return [...f.entries.values()].every((d) => d.authorId !== authorId);
}

function routeAuthorsMe(f: FixtureCatalog, authorId: string, body: unknown, now: number): { reply: FixtureReply; input: Record<string, unknown> } {
  const n = nickname(asObject(body).nickname);
  if (!mayRename(f, authorId)) throw refuse("creator_not_approved", MSG.creatorNotApprovedRename);
  authorOf(f, authorId).nickname = n;
  for (const d of f.entries.values()) {
    if (d.authorId !== authorId) continue;
    d.nickname = n;
    d.updatedAt = Math.max(now, d.updatedAt + 1);
  }
  changed(f);
  return { reply: json(200, { ok: true, nickname: n }), input: { nickname: n } };
}

const PATCHABLE = new Set(["name", "description", "tags", "hidden"]);

function routePatch(f: FixtureCatalog, id: string, authorId: string, body: unknown, now: number): { reply: FixtureReply; input: Record<string, unknown> } {
  const r = asObject(body);
  if (Object.keys(r).some((k) => !PATCHABLE.has(k))) throw refuse("invalid", "Only name, description, tags and hidden can be changed.");
  const edit: Partial<Pick<FixtureDoc, "name" | "description" | "tags">> = {};
  if (r.name !== undefined) edit.name = readName(r.name);
  if (r.description !== undefined) edit.description = readDescription(r.description);
  if (r.tags !== undefined) edit.tags = readTags(r.tags);
  if (r.hidden !== undefined && typeof r.hidden !== "boolean") throw refuse("invalid", "hidden must be true or false.");
  const hidden = r.hidden as boolean | undefined;
  if (Object.keys(edit).length === 0 && hidden === undefined) throw refuse("invalid", "Nothing to change.");
  const input = { id, hidden: hidden ?? null, fields: Object.keys(edit) };
  const d = f.entries.get(id);
  const mine = d !== undefined && d.authorId === authorId;
  if (!d || (d.hidden && !mine)) throw refuse("not_found", MSG.noSuchTemplate);
  if (!mine) throw refuse("forbidden", MSG.notYours);
  if (hidden === false && d.hidden && isModerated(d)) throw new Refusal(403, MSG.unhideModerated, "moderated");
  // Invite-only covers what changes the public listing — an edit or a re-show — never a hide.
  // Checked before anything is written, so a hide sent with a refused edit does not land either.
  if (Object.keys(edit).length > 0 || hidden === false) requireApproved(f, authorId);
  if (hidden === false && d.hidden) {
    const live = templatePrefix(d.id, d.version);
    const retired = retiredPrefix(d.id, d.version);
    if (d.files.some((x) => !f.objects.has(live + x.name) && !f.objects.has(retired + x.name))) throw new Refusal(410, MSG.unhideGone, "gone");
    moveTree(f, retired, live);
    d.hidden = false;
    d.hiddenByOwner = false;
    // Whatever shows a template again clears its statement of reasons (the site's unhideTemplate).
    d.moderation = null;
    d.updatedAt = Math.max(now, d.updatedAt + 1);
    d.listed = true;
    d.indexPending = false;
    changed(f);
  } else if (hidden === true) {
    hide(f, d, "owner", now);
  }
  if (Object.keys(edit).length > 0) {
    Object.assign(d, edit, { updatedAt: Math.max(now, d.updatedAt + 1) });
    changed(f);
  }
  return { reply: json(200, { ok: true, template: shapeMine(d, bucketBase(), now) }), input };
}

/** The bucket: public GET of any object (no listing), PUT only to a live signed target. */
function routeBucket(f: FixtureCatalog, method: string, key: string, body: Buffer, headers: Record<string, string>, now: number): FixtureReply {
  const xml = (status: number, code: string) => ({ status, headers: { "Content-Type": "application/xml" }, body: Buffer.from(`<?xml version='1.0' encoding='UTF-8'?><Error><Code>${code}</Code></Error>`) });
  if (method === "PUT") {
    const fault = takeFault(f, "upload");
    if (fault) return xml(503, "ServiceUnavailable");
    const signed = f.signed.get(key);
    if (!signed) return xml(403, "SignatureDoesNotMatch");
    if (now >= signed.expiresAt) return xml(400, "ExpiredToken");
    if (header(headers, "content-type") !== signed.contentType) return xml(403, "SignatureDoesNotMatch");
    if (header(headers, "x-goog-content-length-range") !== `0,${signed.bytes}`) return xml(403, "SignatureDoesNotMatch");
    if (body.byteLength > signed.bytes) return xml(400, "EntityTooLarge");
    putObject(f, key, Buffer.from(body), signed.contentType);
    return { status: 200, headers: {}, body: EMPTY };
  }
  if (method !== "GET" && method !== "HEAD") return xml(405, "MethodNotAllowed");
  const obj = f.objects.get(key);
  if (!obj) return xml(404, "NoSuchKey");
  // The same hardened serving as every other stored byte from libi's origin.
  const served = storedBytesServing(obj.contentType, key.slice(key.lastIndexOf("/") + 1));
  return {
    status: 200,
    headers: { "Content-Type": served.contentType, ...served.headers, "Content-Length": String(obj.body.byteLength), "Cache-Control": "no-store" },
    body: method === "HEAD" ? EMPTY : obj.body,
  };
}

// ---------------------------------------------------------------------------
// The trace
// ---------------------------------------------------------------------------

export const FIXTURE_TRACE_FILE = "templates-catalog-calls.jsonl";

function record(tool: string, input: unknown, status: number, code?: string): void {
  try {
    const dir = path.join(getLibiHome(), "test-mode");
    fs.mkdirSync(dir, { recursive: true });
    const line = { ts: new Date().toISOString(), tool, input, status, ...(code ? { code } : {}) };
    fs.appendFileSync(path.join(dir, FIXTURE_TRACE_FILE), `${JSON.stringify(line)}\n`);
  } catch {
    // Diagnostic only: a trace that cannot be written never fails the call.
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

const ID_ROUTE = /^([^/]+)(?:\/(use|report))?$/;

/**
 * One request to the fixture: `p` is the path under
 * `/api/test-mode/templates-catalog/` (no leading slash). 404 with no body
 * outside test mode, for every method and path.
 */
export async function handleFixtureRequest(method: string, p: string, body: Buffer, headers: Record<string, string>): Promise<FixtureReply> {
  if (!isTestMode()) return NOT_FOUND;
  const f = getFixtureCatalog();
  const now = Date.now();
  const raw = method.toUpperCase();
  // HEAD is GET without the body (the Next route drops it), as Next answers the site's GET routes.
  const m = raw === "HEAD" ? "GET" : raw;

  if (p.startsWith("bucket/")) return routeBucket(f, raw, p.slice("bucket/".length), body, headers, now);

  if (p === "_faults" && m === "POST") {
    const usage = json(400, { ok: false, error: `Expected { route, code, times? } or { clear: true }: route one of ${FIXTURE_ROUTES.join(", ")}, code a site code or "unindexed".` });
    let r: Record<string, unknown>;
    try {
      r = asObject(readJson(body, headers, BODY_CAP));
    } catch {
      return usage;
    }
    if (r.clear === true) f.faults.length = 0;
    else {
      const known = (FIXTURE_ROUTES as readonly unknown[]).includes(r.route) && (r.code === "unindexed" || Object.hasOwn(FIXTURE_CODE_STATUS, String(r.code)));
      const times = r.times === undefined ? 1 : r.times;
      if (!known || typeof times !== "number" || !Number.isSafeInteger(times) || times < 1) return usage;
      injectFixtureFault({ route: r.route as FixtureRoute, code: r.code as FixtureFault["code"], times });
    }
    return json(200, { ok: true, faults: f.faults });
  }

  // Which route, and the trace tool it records as.
  let route: FixtureRoute | null = null;
  const idMatch = ID_ROUTE.exec(p);
  if (p === "index" && m === "GET") route = "index";
  else if (p === "publish/prepare" && m === "POST") route = "prepare";
  else if (p === "publish/commit" && m === "POST") route = "commit";
  else if (p === "mine" && m === "GET") route = "mine";
  else if (p === "authors/me" && m === "PUT") route = "authors_me";
  else if (p === "creators/me" && (m === "GET" || m === "POST")) route = "creators_me";
  else if (idMatch && !idMatch[2] && m === "GET") route = "get";
  else if (idMatch && !idMatch[2] && m === "PATCH") route = "visibility";
  else if (idMatch && idMatch[2] === "use" && m === "POST") route = "use";
  else if (idMatch && idMatch[2] === "report" && m === "POST") route = "report";
  if (route === null) return NOT_FOUND;
  const open = route === "index" || route === "get";
  const client = header(headers, "x-libi-fixture-client") ?? "local";
  const id = idMatch?.[1] ?? "";
  let input: Record<string, unknown> = route === "get" || route === "use" || route === "visibility" ? { id } : {};

  try {
    const fault = takeFault(f, route);
    if (fault) throw faultRefusal(fault as PublishErrorCode, fault === "wrong_version" ? faultExpectedVersion(f, body, headers) : undefined, route);
    if ((route === "get" || route === "use" || route === "report" || route === "visibility") && !CLOUD_ID_PATTERN.test(id)) throw refuse("invalid", MSG.badId);
    let reply: FixtureReply;
    switch (route) {
      case "index":
        reply = routeIndex(f, headers, now);
        break;
      case "get":
        reply = routeGet(f, id, now);
        break;
      case "prepare":
      case "commit": {
        const authorId = requireAuthor(headers);
        const raw = readJson(body, headers, PREPARE_BODY_CAP);
        const out = route === "prepare" ? routePrepare(f, authorId, raw, now) : routeCommit(f, authorId, raw, now);
        input = out.input;
        reply = out.reply;
        break;
      }
      case "use":
        asObject(readJson(body, headers, BODY_CAP));
        reply = routeUse(f, id, client, now);
        break;
      case "report": {
        const raw = readJson(body, headers, BODY_CAP);
        const obj = typeof raw === "object" && raw !== null && !Array.isArray(raw) ? (raw as { reason?: unknown; details?: unknown }) : {};
        const reason = obj.reason;
        // Whether details came, never the text: the trace is read by skill-eval and kept on disk.
        input = { id, reason: typeof reason === "string" ? reason : null, hasDetails: typeof obj.details === "string" && obj.details.trim().length > 0 };
        if (typeof reason !== "string" || !(REPORT_REASONS as readonly string[]).includes(reason)) throw refuse("invalid", `reason must be one of ${REPORT_REASONS.join(", ")}.`);
        reply = routeReport(f, id, reason as ReportReason, reportDetails(obj.details), client, now);
        break;
      }
      case "mine":
        reply = routeMine(f, requireAuthor(headers), now);
        break;
      case "authors_me": {
        const authorId = requireAuthor(headers);
        const out = routeAuthorsMe(f, authorId, readJson(body, headers, BODY_CAP), now);
        input = out.input;
        reply = out.reply;
        break;
      }
      case "creators_me": {
        // Traced by method only: the email and the note never reach the trace.
        input = { method: m };
        const authorId = requireAuthor(headers);
        if (m === "GET") {
          reply = json(200, { ok: true, status: creatorStatusOf(f, authorId) });
          break;
        }
        const r = asObject(readJson(body, headers, CREATOR_BODY_CAP));
        if (typeof r.email !== "string" || r.email.trim().length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(r.email.trim())) throw refuse("invalid", MSG.badEmail);
        const cur = creatorStatusOf(f, authorId);
        if (cur === "rejected") throw refuse("creator_request_closed", MSG.creatorRequestClosed);
        // An approved author is answered approved and nothing is written.
        if (cur !== "approved") f.creators.set(authorId, "pending");
        reply = json(200, { ok: true, status: cur === "approved" ? "approved" : "pending" });
        break;
      }
      case "visibility": {
        const authorId = requireAuthor(headers);
        const out = routePatch(f, id, authorId, readJson(body, headers, BODY_CAP), now);
        input = out.input;
        reply = out.reply;
        break;
      }
      default:
        return NOT_FOUND;
    }
    record(route, input, reply.status);
    return reply;
  } catch (err) {
    // A fixture bug: answered as the site answers its own (500 internal), and logged as the site logs one.
    if (!(err instanceof Refusal)) logger.error({ tag: "templates", op: "fixture_internal", route, err }, "test-mode catalog fixture failed");
    const r = err instanceof Refusal ? err : new Refusal(500, MSG.internal, "internal");
    record(route, input, r.status, r.code);
    return refusalReply(r, open);
  }
}
