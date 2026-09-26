import { PRODUCTION_SITE_URL } from "@/lib/site-url";

/** Mirrors libi-site lib/templates/constants.ts — flips together. */
export const PUBLIC_CODE_TEMPLATES = false;

const KB = 1024;
const MB = 1024 * KB;
export const CAPS = {
  image: 2 * MB,
  font: 4 * MB,
  code: 128 * KB,
  scaffold: 256 * KB,
  instructions: 32 * KB,
  example: 8 * MB,
  poster: 400 * KB,
  total: 24 * MB,
} as const;
export const MAX_FILES = 60;
/**
 * The largest prepare or commit request the site reads (libi-site
 * lib/templates/http.ts#PREPARE_BODY_CAP): 413 "Request body is too large."
 * The body carries template.json (≤ 256 KB on its own) AND index.md and the
 * manifest, so a template can fit every file cap and still not fit this.
 */
export const PUBLISH_BODY_CAP = 256 * KB;
/** How long prepare's signed upload URLs work (libi-site lib/templates/constants.ts#SIGNED_URL_TTL_MS). */
export const SIGNED_URL_TTL_MS = 15 * 60 * 1000;
// The rest mirror libi-site lib/templates/constants.ts one for one; the
// publish preflight (lib/templates/cloud/preflight.ts) applies them.
export const MAX_NAME = 80;
export const MAX_DESCRIPTION = 500;
export const MAX_TAGS = 10;
export const TAG_PATTERN = /^[a-z0-9][a-z0-9-]{0,29}$/;
export const ASSET_BASENAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
export const NICKNAME_PATTERN = /^[A-Za-z0-9 _-]{2,32}$/;
export const IMAGE_EXTS = ["jpg", "jpeg", "png", "webp", "svg"] as const;
export const FONT_EXTS = ["ttf", "otf", "woff2"] as const;
export const EXAMPLE_MIN_SECONDS = 0.1;
export const EXAMPLE_MAX_SECONDS = 15;
export const EXAMPLE_MAX_LONG_EDGE = 1280;
export const CLOUD_ID_PATTERN = /^[a-z2-7]{20}$/;
/**
 * The file names the site admits (libi-site lib/templates/prepare.ts): the
 * four fixed ones, `overlays/<key>/(draw|scene).jsx`, and `assets/<basename>`
 * with an allowlisted image or font extension. Lower case, no `..` segment,
 * no `%`, no backslash — a name is also a path under the template's folder,
 * both in the bucket and on disk.
 */
export const CLOUD_FILE_NAME_PATTERN =
  /^(template\.json|index\.md|poster\.jpg|example\.mp4|overlays\/[a-z][a-z0-9-]{0,39}\/(draw|scene)\.jsx|assets\/[a-z0-9][a-z0-9._-]{0,63}\.(jpg|jpeg|png|webp|svg|ttf|otf|woff2))$/;
/** The most entries the site's index ever holds (libi-site lib/templates/constants.ts). An index over it is refused whole. */
export const INDEX_CAP = 20_000;
export const REPORT_REASONS = ["spam", "offensive", "broken", "copyright", "other"] as const;
export type ReportReason = (typeof REPORT_REASONS)[number];
/**
 * The longest free text a report carries (libi-site REPORT_DETAILS_MAX),
 * after trimming. Multi-line text under the site's character rules
 * (./text-rules#multiLineTextProblem); the site refuses anything else 400.
 */
export const REPORT_DETAILS_MAX = 2000;

/** Both public bases, hard-coded: the app accepts index URLs only under the one for its environment. */
export const CATALOG_BUCKET_BASES = {
  production: "https://storage.googleapis.com/libi-prod-templates/",
  development: "https://storage.googleapis.com/libi-dev-templates/",
} as const;

/**
 * What a catalog source (lib/templates/cloud/catalog-source.ts) is called when
 * it is the test-mode fixture rather than a site origin.
 */
export const TEST_MODE_SOURCE = "test-mode";

/**
 * The bucket base of the catalog `source`: the production bucket for the
 * production site, the dev bucket for any other site (a local libi-site, a
 * Vercel preview — both write libi-dev's bucket), and in test mode the
 * studio's own fixture route (which needs the studio port — pass it; the
 * server reads it from lib/libi-home).
 *
 * Keyed by the CATALOG, not the build: a dev build switched to Production
 * reads the production bucket (lib/templates/cloud/catalog-setting.ts).
 * Test mode without a port throws rather than falling through to a real
 * bucket: a caller that forgot the port would otherwise read production.
 */
export function catalogBucketBase(source: string, studioPort?: number): string {
  if (source === TEST_MODE_SOURCE) {
    if (!studioPort) throw new Error("catalogBucketBase: test mode needs the studio port (getCurrentPort())");
    return `http://127.0.0.1:${studioPort}/api/test-mode/templates-catalog/bucket/`;
  }
  return source === PRODUCTION_SITE_URL ? CATALOG_BUCKET_BASES.production : CATALOG_BUCKET_BASES.development;
}

/**
 * What libi says when the site refuses with `moderated` — never the site's own
 * words — and what the Templates page shows beside a moderated template. Here,
 * not in ./client (Node-only), so a client component can import it.
 */
export const MODERATED_MESSAGE =
  "This template was hidden by moderation (reports or a takedown). Its owner can't show it again from libi.";

/**
 * Why a template was taken down — the statement of reasons (Terms §11) that
 * `/mine` returns for the author's own moderated templates (libi-site
 * MODERATION_REASONS, same order). An operator sets the first five on the
 * catalog's template doc; `reports` is the one the site writes itself, on an
 * automatic hide after reports, pending review — an operator who reviews it
 * and keeps it down replaces it. A reason libi doesn't know reads as `other`.
 */
export const MODERATION_REASONS = ["copyright", "rights", "illegal", "terms", "other", "reports"] as const;
export type ModerationReason = (typeof MODERATION_REASONS)[number];
/** How Your templates names each reason: "Removed — <label>" (`reports` stands alone: see `moderationHeadline`). */
export const MODERATION_REASON_LABELS: Record<ModerationReason, string> = {
  copyright: "Copyright",
  rights: "Someone else's rights",
  illegal: "Illegal content",
  terms: "Breaks the Terms",
  other: "Other",
  // Terms §11 quotes it: "hidden after reports, pending review".
  reports: "Hidden after reports — pending review",
};

/**
 * The first words beside a moderated template: "Removed — <reason>" for a
 * takedown we decided, and for an automatic hide after reports — not a
 * decision yet — the label alone, "Hidden after reports — pending review".
 */
export function moderationHeadline(reason: ModerationReason): string {
  return reason === "reports" ? MODERATION_REASON_LABELS.reports : `Removed — ${MODERATION_REASON_LABELS[reason]}`;
}
/**
 * The longest Retry-After libi honours from the catalog, in seconds —
 * the server's backoffs and the page's hook alike. One absurd header
 * (a day, a year) must not lock every public template page.
 */
export const CATALOG_RETRY_AFTER_CAP_SEC = 600;

/** The longest operator note the site returns (libi-site MODERATION_NOTE_MAX). */
export const MODERATION_NOTE_MAX = 500;

/**
 * What the owner is told when a hide or unhide got no answer, a 5xx, or a 2xx
 * libi could not read (`code: "outcome_unknown"` from the visibility route): the
 * change may well have landed, so libi claims neither way.
 */
export const VISIBILITY_OUTCOME_UNKNOWN_MESSAGE = "libi couldn't tell whether the catalog took the change; the list shows what it says now.";

/**
 * The review panel's line before the user publishes (the Templates page,
 * components/templates/templates-page/publish-review.tsx), verbatim.
 */
export const PUBLISH_PUBLIC_WARNING = "Publishing makes this public. Anyone can install it; unpublishing doesn't recall copies already installed.";

/**
 * The review panel's required box (Terms §4A: the rights promise, confirmed
 * at every publish), verbatim. Here, not in ./publish-confirm (which imports
 * lib/jobs), so the panel can read it.
 */
export const RIGHTS_CONFIRMATION_LABEL = "I own or have the rights to everything in this template, including its example video, images, fonts, voices and music";
/** What the confirm route answers (400 `rights_not_confirmed`) when the box wasn't ticked. */
export const RIGHTS_REQUIRED = "Tick the box to confirm you have the rights to everything in this template, then publish.";

/**
 * Publishing to the public catalog is invite-only: only a creator key the
 * owner approved may publish (libi-site lib/templates/creators.ts). What the
 * site reports for a key: never applied, applied and waiting, approved, or
 * turned down. Here, not in ./client (Node-only), so a client component can
 * read it.
 */
export const CREATOR_STATUSES = ["none", "pending", "approved", "rejected"] as const;
export type CreatorStatus = (typeof CREATOR_STATUSES)[number];
/** The longest note an application carries (libi-site CREATOR_NOTE_MAX). */
export const CREATOR_NOTE_MAX = 500;
/** libi's one sentence for invite-only publishing: the header, the review panel's gate and the apply dialog all say it. */
export const INVITE_ONLY = "Publishing to the public catalog is invite-only.";
/**
 * libi's words for `creator_not_approved` — never the site's. Its core
 * ("Publishing is invite-only; apply on the Templates page") is the MCP
 * refusal the plan pins verbatim for the agent, so it stays a sentence of its
 * own rather than INVITE_ONLY.
 */
export const CREATOR_NOT_APPROVED_MESSAGE = "Publishing is invite-only; apply on the Templates page (\"Apply to publish\"). Nothing was published.";
/**
 * libi's words when "Show again" is refused with `creator_not_approved`: showing
 * a hidden template again puts it back in the catalog, which only an approved
 * creator may do. The template stays hidden — nothing else changed. (A hide is
 * never refused for this.)
 */
export const CREATOR_NOT_APPROVED_UNHIDE_MESSAGE =
  "Only approved creators can show a template in the public catalog again — publishing is invite-only. It stays hidden; apply on the Templates page (\"Apply to publish\").";
/**
 * The `refresh_query` key that re-reads the creator's approval (and nothing
 * else). Deliberately NOT under the `templates` prefix: every template write
 * invalidates that, and each re-read of this status costs one of the site's
 * status reads — 10 a minute per IP in the `creators-status` bucket, shared
 * with libi.publish_template's gate. (Applying to publish has its own
 * 10-a-minute `creators-apply` bucket on the site: a status read never spends
 * an application's budget, nor the other way round.) Emitted when a publish,
 * a "Show again" or a nickname change is refused with `creator_not_approved`
 * (lib/queries/templates-cloud.ts `useCreatorStatus`).
 */
export const CREATOR_STATUS_REFRESH_KEY = "templates-creator";
/**
 * libi's words when a nickname change is refused with `creator_not_approved`:
 * the nickname is on every template the author published, so an author who
 * has published one — hidden or not — must be an approved creator to change
 * it (libi-site lib/templates/creators.ts#mayRename). Worded after the
 * site's Terms §4A ("once you have published one, only an approved creator
 * can change it, even while your templates are hidden"), and never "in the
 * catalog": libi calls a hidden template out of the catalog.
 */
export const CREATOR_NOT_APPROVED_RENAME_MESSAGE =
  "You can't change your nickname: once you've published a template, only an approved creator can change it, even while your templates are hidden.";
/**
 * The query key of the templates-catalog view (GET
 * /api/templates/cloud/catalog-setting; lib/queries/templates-catalog.ts),
 * and the `refresh_query` key a switch emits. NOT under `templates`: every
 * template write invalidates that prefix, and this changes only on a switch.
 */
export const TEMPLATES_CATALOG_REFRESH_KEY = "templates-catalog";
/** libi's words for `creator_request_closed` (an application already decided) — never the site's. */
export const CREATOR_REQUEST_CLOSED_MESSAGE = "Your application to publish was already decided. Email admin@nagellabs.com if you think that's a mistake.";
