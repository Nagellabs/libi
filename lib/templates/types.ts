import type { TemplateSlot } from "@/lib/templates/scaffold";

export type TemplateOrder = "trending" | "most-used" | "newest";
export type TemplateScope = "local" | "public" | "all";

/**
 * What a list, a search and the page see. `id` is null ONLY for a catalog
 * entry that is not installed (`origin: "public"`, from the cached index);
 * every row in `templates` has one. `broken` carries the folder's validation
 * failure (spec §9) — such a template is listed but cannot be applied.
 *
 * A public entry comes from the index, which carries no slots and no frame
 * rate: its `slots` is empty (read `slotCount`) and `canvas.fps` is null.
 * Its text fields are a STRANGER's words — whatever hands them to an agent
 * labels them (mcp/tools/template-tools.ts).
 */
export interface TemplateSummary {
  id: string | null;
  cloudId: string | null;
  name: string;
  description: string;
  tags: string[];
  origin: "local" | "installed" | "public";
  version: number;
  hasCode: boolean;
  slots: TemplateSlot[];
  slotCount: number;
  canvas: { width: number; height: number; fps: number | null };
  duration: number;
  usesTotal: number;
  uses7d: number;
  lastUsedAt: string | null;
  createdAt: string;
  updatedAt: string;
  hasPoster: boolean;
  hasExample: boolean;
  /** An absolute bucket URL (public), the studio's media route (local), or null. */
  poster: string | null;
  video: string | null;
  /** The publisher's nickname — public entries only. */
  nickname: string | null;
  broken: string | null;
  /**
   * A row installed from, or published to, ANOTHER catalog than the one this
   * libi reads ("test-mode", or a site origin): here it is not linked —
   * `cloudId` is null, and it is never updated from or reported to either.
   * Null otherwise (lib/templates/cloud/catalog-source.ts).
   */
  otherCatalog: string | null;
  /**
   * The newest mtime (ms) of the local folder's poster.jpg / example.mp4, 0
   * when it has neither (and for a public entry). Media URLs carry it beside
   * the version, so an example rendered after the fact shows without a
   * version bump.
   */
  mediaRev: number;
  /**
   * The Templates page can render this template's example: a LOCAL template
   * whose source piece still exists. False for installed and public ones
   * (they keep their author's example) and once the piece is deleted.
   */
  canRenderExample: boolean;
  /**
   * The source piece's name while it exists — for a LOCAL template only (null
   * for installed and public ones, and once the piece is deleted). "Render
   * preview" renders that piece as it is now, which may have changed since
   * the template was made, so the page names it before rendering.
   */
  sourcePieceName: string | null;
}

/** One cached public entry as `GET /api/templates/cloud/catalog` sends it.
 *  `poster`/`video` are relative to the response's `base`. */
export interface CatalogEntryDto {
  cloudId: string;
  name: string;
  description: string;
  tags: string[];
  nickname: string;
  authorId: string;
  version: number;
  hasCode: boolean;
  canvasWidth: number;
  canvasHeight: number;
  duration: number;
  slotCount: number;
  poster: string;
  video: string;
  usesTotal: number;
  uses7d: number;
  heat: number;
  createdAt: string;
  updatedAt: string;
  fetchedAt: string;
}

export interface CatalogIndexResponse {
  entries: CatalogEntryDto[];
  /** When the cached copy was last confirmed current; null before the first successful fetch. */
  fetchedAt: string | null;
  /** This environment's bucket base (the studio's fixture route in test mode). */
  base: string;
  refreshed: boolean;
  /**
   * This install's own publishes, hides and shows that the entries don't
   * show yet (the site's index is edge-cached for up to five minutes): the
   * Public tab shows them from `/mine` meanwhile. Absent from an older studio.
   */
  ownChanges?: OwnCatalogChangeDto[];
  /** Why the last refresh failed — the entries are then the last good copy. */
  error?: string;
}

/** One of `CatalogIndexResponse.ownChanges` (lib/templates/cloud/catalog-cache.ts#OwnCatalogChange). */
export interface OwnCatalogChangeDto {
  cloudId: string;
  version: number;
  kind: "published" | "shown" | "hidden";
  /** When libi noted it. */
  at: string;
}

/**
 * Why GET /api/templates/cloud/mine could not read the catalog's list — a
 * fixed code, never the site's words: `unreachable` (no answer at all),
 * `unauthorized` (the catalog refused this install's creator key),
 * `unavailable` (it answered, but not with the list).
 */
export type MineErrorCode = "unreachable" | "unauthorized" | "unavailable";

/**
 * Which public templates catalog this libi reads (GET
 * /api/templates/cloud/catalog-setting). A dev build also carries its Catalog
 * setting (Settings → Templates); a packaged or npm build only `active`.
 * Never the bypass token itself — only whether one is set.
 */
export interface TemplatesCatalogActive {
  kind: "production" | "development" | "test-mode";
  /** The catalog site's origin; null in test mode (the studio's own fixture). */
  origin: string | null;
  host: string | null;
}
export type TemplatesCatalogView =
  | { devBuild: false; testMode: boolean; active: TemplatesCatalogActive; legalOrigin: string }
  | {
      devBuild: true;
      testMode: boolean;
      active: TemplatesCatalogActive;
      /** Terms and Privacy links point here: the development site's own while it is active, else production. */
      legalOrigin: string;
      choice: "production" | "development";
      production: { origin: string; host: string };
      development: { origin: string | null; isDefault: boolean; defaultOrigin: string | null };
      bypassToken: { set: boolean; applies: boolean };
    };

/**
 * A local template's publish that has not landed (GET /api/templates/cloud/pending):
 *  - `publishing`       a publish job for it is queued or running now;
 *  - `unfinished`       an attempt stopped part-way; the next publish of it finishes THAT publish;
 *  - `needs-attention`  libi stopped retrying it (`detail` says why): discard, then prepare it again;
 *  - `reserved`         nothing in flight — only its catalog id is kept for the next publish;
 *  - `unreadable`       the record can't be read, so libi won't guess: discard it;
 *  - `other-catalog`    started against another catalog than this libi reads
 *                       (test mode ⇄ a normal boot): `detail` says which, and what can be done.
 */
export type PendingPublishState = "publishing" | "unfinished" | "needs-attention" | "reserved" | "unreadable" | "other-catalog";
export interface PendingPublish {
  templateId: string;
  /** The user's own local template's name (only local templates publish). */
  name: string;
  state: PendingPublishState;
  cloudId: string | null;
  version: number | null;
  /** Why libi stopped retrying (`needs-attention`), or which catalog it belongs to (`other-catalog`) — libi's own words. */
  detail: string | null;
}

/**
 * A publish an agent prepared (`libi.publish_template`) for the user to make
 * or refuse on the Templates page — the review panel's data
 * (`GET /api/templates/cloud/publish-requests`, lib/templates/cloud/publish-requests.ts).
 *
 *   - `awaiting`   ready for review;
 *   - `publishing` the user confirmed and the publish job is running;
 *   - `failed`     that job did not publish (`error` says why) — confirming
 *                  again starts a fresh attempt;
 *   - `changed`    the template is no longer what was prepared (`error` says
 *                  so): it can only be discarded, and the agent asked to
 *                  prepare it again.
 */
export type PublishRequestState = "awaiting" | "publishing" | "failed" | "changed";

export type PublishRequestExample =
  | { kind: "file"; fileId: string; filename: string; pieceName: string | null }
  | { kind: "path"; fileName: string; path: string }
  | { kind: "export"; pieceId: string; pieceName: string | null };

export interface PublishRequestView {
  id: string;
  templateId: string;
  state: PublishRequestState;
  /** The user's own template's text, as it will be listed. */
  name: string;
  description: string;
  tags: string[];
  /** Where the example was made from, in the user's words. */
  example: PublishRequestExample;
  /**
   * The request's own example video and poster — exactly what a publish sends
   * — served from its folder; null when they are gone (the state is then
   * `changed`).
   */
  media: { videoUrl: string; posterUrl: string; exampleBytes: number; posterBytes: number } | null;
  /** The public nickname this publish goes out under, and whether it is new (it renames every published template). */
  nickname: { value: string | null; isNew: boolean; replaces: string | null };
  /** Exactly what becomes public, one line each, in libi's words. */
  publicItems: Array<{ label: string; detail: string | null }>;
  /** A republish: the template is already in the catalog, and this updates it. */
  republish: boolean;
  /**
   * The catalog this request was prepared for — and the only one its confirm
   * can publish to (the confirm refuses a request of another catalog). The
   * review names it from here, so the line is there whenever the request is,
   * never waiting on a separate read of the active catalog.
   */
  catalog: TemplatesCatalogActive;
  /** libi's words: why the last attempt failed, or why the request went stale. */
  error: string | null;
  /**
   * Proof the confirm came from this panel. Present only when the page itself
   * asked (a same-origin browser read) — never in any tool result or log.
   */
  confirmCode?: string;
  createdAt: number;
}
