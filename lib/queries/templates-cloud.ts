"use client";

/**
 * The public catalog through libi's own routes: the creator side — the
 * creator key (Settings → General), "Publishing as" and its pending publishes
 * (Templates page) with the creator's approval to publish, the numbers and visibility of what this install published
 * (`/mine`), hiding one — and the Public tab's install and report. The
 * renderer never talks to the site itself.
 *
 * The key is a bearer secret, and no cache entry here ever holds it: the
 * status query and every mutation answer carry only its mask. The key itself
 * comes from `revealCreatorKey()` — a POST the proxy's origin and
 * DNS-rebinding gate covers — called on the user's explicit Reveal or Copy,
 * and kept in that card's own state until Hide or unmount. Nothing here logs
 * it or puts it in a URL.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { templateKeys } from "@/lib/queries/templates";
import type { CloudTemplate, MineTemplate } from "@/lib/templates/cloud/client";
import type { TemplateScaffold } from "@/lib/templates/scaffold";
import { CATALOG_RETRY_AFTER_CAP_SEC, CREATOR_STATUS_REFRESH_KEY, RIGHTS_REQUIRED, VISIBILITY_OUTCOME_UNKNOWN_MESSAGE, type CreatorStatus, type ReportReason } from "@/lib/templates/cloud/constants";
import type { MineErrorCode, PendingPublish, PublishRequestView } from "@/lib/templates/types";

export const templatesCloudKeys = {
  keyStatus: ["templates", "cloud", "key-status"] as const,
  author: ["templates", "cloud", "author"] as const,
  mine: ["templates", "cloud", "mine"] as const,
  pending: ["templates", "cloud", "pending"] as const,
  publishRequests: ["templates", "cloud", "publish-requests"] as const,
  /**
   * NOT under `["templates"]`, unlike the rest: every template write
   * invalidates that prefix, and each re-read of this one costs one of the
   * site's status reads (10 a minute in its own `creators-status` bucket —
   * applications have a separate one — shared with libi.publish_template's
   * gate). It is re-read only when something can
   * have changed it — see `useCreatorStatus`.
   */
  creator: [CREATOR_STATUS_REFRESH_KEY] as const,
  /** A public template's page. Under `templates`, so an install re-reads it (its `installedTemplateId`). */
  detail: (cloudId: string) => ["templates", "cloud", "detail", cloudId] as const,
};

/**
 * The creator key's status: its mask — never the key itself. Reading it
 * creates the identity (with its default nickname) on the first view.
 * `publishedHere`: this machine holds a publish under it (the import warns then).
 */
export interface CreatorKeyStatus {
  hasKey: boolean;
  masked: string | null;
  authorId: string | null;
  nickname: string | null;
  publishedHere: boolean;
}

export interface TemplatesAuthorValue {
  nickname: string | null;
  authorId: string | null;
}

/** A route's refusal: its message, and the site's (or libi's) `code` when it sent one — switch on that. */
export class CloudRouteError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = "CloudRouteError";
  }
}

async function readJson<T>(res: Response, fallback: string): Promise<T> {
  const json = (await res.json().catch(() => ({}))) as T & { error?: unknown; code?: unknown };
  if (!res.ok) {
    throw new CloudRouteError(typeof json.error === "string" ? json.error : fallback, res.status, typeof json.code === "string" ? json.code : undefined);
  }
  return json;
}

function sendJson(url: string, method: string, body: unknown): Promise<Response> {
  return fetch(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
}

function authorOf(v: CreatorKeyStatus): TemplatesAuthorValue {
  return { nickname: v.nickname, authorId: v.authorId };
}

export function useCreatorKeyStatus() {
  return useQuery({
    queryKey: templatesCloudKeys.keyStatus,
    queryFn: () => fetch("/api/templates/cloud/key").then((r) => readJson<CreatorKeyStatus>(r, "Failed to load the creator key")),
    staleTime: 60_000,
  });
}

/**
 * The creator key itself, for an explicit Reveal or Copy. Deliberately not a
 * query or a mutation: both keep their result in a cache that outlives the
 * card. The caller holds it in local state and drops it on Hide.
 */
export async function revealCreatorKey(): Promise<string> {
  const r = await fetch("/api/templates/cloud/key/reveal", { method: "POST" });
  return (await readJson<{ key: string }>(r, "Couldn't reveal the creator key")).key;
}

/** The route's answer to an import that would replace a different stored key without `replace: true`. */
export const REPLACE_REQUIRED = "replace_required";

/**
 * Import a key from another machine. The server decides whether it replaces a
 * different key — it compares the whole key, the card sees only the mask — and
 * refuses that without `replace: true` when the current key has been used (a
 * `CloudRouteError` coded `replace_required`, left to the card to turn into its
 * confirmation, so not toasted): the current key's templates stop being
 * editable here. An unused key is replaced without asking.
 */
export function useImportCreatorKey() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { key: string; replace: boolean }) =>
      sendJson("/api/templates/cloud/key", "PUT", v).then((r) => readJson<CreatorKeyStatus>(r, "Failed to import the key")),
    onSuccess: (v) => {
      qc.setQueryData(templatesCloudKeys.keyStatus, v);
      qc.setQueryData(templatesCloudKeys.author, authorOf(v));
      void qc.invalidateQueries({ queryKey: templatesCloudKeys.mine });
      void qc.invalidateQueries({ queryKey: templatesCloudKeys.pending });
      // Approval to publish belongs to the key.
      void qc.invalidateQueries({ queryKey: templatesCloudKeys.creator });
      void qc.invalidateQueries({ queryKey: templateKeys.all });
      toast.success("Creator key imported");
    },
    onError: (e: Error) => {
      if (e instanceof CloudRouteError && e.code === REPLACE_REQUIRED) return;
      toast.error(e.message);
    },
  });
}

/**
 * The creator's approval to publish (publishing is invite-only): `status` is
 * the site's word, or null when it couldn't be reached (`error` says why) —
 * the route never fails for that, so this query does not either.
 */
export interface CreatorStatusValue {
  status: CreatorStatus | null;
  error?: "unreachable" | "unavailable";
}

/**
 * How long a read of the creator's approval is trusted. Approval is decided by
 * hand, so minutes of lag cost nothing — and it is also the floor between two
 * window-focus re-reads.
 */
export const CREATOR_STATUS_STALE_MS = 5 * 60_000;

/**
 * "Publishing as"'s creator line and the review panel's gate. Every read asks
 * the site (the route spends the creator key on `/creators/me`, whose budget
 * is 10 a minute), so it is re-read only on what can change it:
 *   - applying (`useApplyAsCreator`) and importing a key (`useImportCreatorKey`);
 *   - a refusal for it — a publish job's, "Show again"'s, or
 *     libi.publish_template's gate — via `refresh_query templates-creator`;
 *   - window focus, at most once per `CREATOR_STATUS_STALE_MS` (the owner may
 *     have approved meanwhile), and a mount once it is that old.
 * Never by a template write: its key sits outside the `templates` prefix.
 */
export function useCreatorStatus() {
  return useQuery({
    queryKey: templatesCloudKeys.creator,
    queryFn: () => fetch("/api/templates/cloud/creator").then((r) => readJson<CreatorStatusValue>(r, "Couldn't check your publishing status")),
    staleTime: CREATOR_STATUS_STALE_MS,
    refetchOnWindowFocus: true,
  });
}

/** "Apply to publish". A refusal is libi's own copy, shown in the form — so no toast here. */
export function useApplyAsCreator() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { email: string; note: string }) =>
      sendJson("/api/templates/cloud/creator", "POST", v).then((r) => readJson<{ status: CreatorStatus }>(r, "Couldn't send the application")),
    onSettled: () => void qc.invalidateQueries({ queryKey: templatesCloudKeys.creator }),
  });
}

export function useTemplatesAuthor() {
  return useQuery({
    queryKey: templatesCloudKeys.author,
    queryFn: () => fetch("/api/templates/cloud/author").then((r) => readJson<TemplatesAuthorValue>(r, "Failed to load the author")),
    staleTime: 60_000,
  });
}

/** Set the nickname. Its error is shown inline by "Publishing as", so there is no toast here. */
export function useSetNickname() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (nickname: string) =>
      sendJson("/api/templates/cloud/author", "PUT", { nickname }).then((r) => readJson<{ nickname: string; authorId: string }>(r, "Couldn't set the nickname")),
    onSuccess: (v) => {
      qc.setQueryData(templatesCloudKeys.author, v);
      // "Publishing as" prefers `/mine`'s nickname: patch it now, so the old name doesn't show until the refetch lands.
      qc.setQueryData<CloudMine>(templatesCloudKeys.mine, (d) => (d ? { ...d, nickname: v.nickname } : d));
      void qc.invalidateQueries({ queryKey: templatesCloudKeys.keyStatus });
      void qc.invalidateQueries({ queryKey: templatesCloudKeys.mine });
    },
  });
}

export function usePendingPublishes() {
  return useQuery({
    queryKey: templatesCloudKeys.pending,
    queryFn: () => fetch("/api/templates/cloud/pending").then((r) => readJson<{ pending: PendingPublish[] }>(r, "Failed to load pending publishes")),
    select: (d) => d.pending,
  });
}

/**
 * Discard a template's pending publish. The route refuses (409, with
 * guidance) any discard that could let the next publish make a second public
 * copy; the row shows that refusal inline, so there is no error toast here.
 */
export function useDiscardPendingPublish() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (templateId: string) =>
      sendJson("/api/templates/cloud/pending", "DELETE", { templateId }).then((r) => readJson<{ ok: true }>(r, "Couldn't discard the pending publish")),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: templatesCloudKeys.pending });
      toast.success("Pending publish discarded");
    },
    onError: () => {
      void qc.invalidateQueries({ queryKey: templatesCloudKeys.pending });
    },
  });
}

/**
 * The publishes agents prepared, as the Templates page's review panels.
 * Updated live by the `templates` refresh the tool, the confirm and the job's
 * end all emit; polled only while one is publishing, so a publish that ended
 * without a word (a restart) still settles on screen.
 */
export function usePublishRequests() {
  return useQuery({
    queryKey: templatesCloudKeys.publishRequests,
    queryFn: () =>
      fetch("/api/templates/cloud/publish-requests", { cache: "no-store" }).then((r) =>
        readJson<{ requests: PublishRequestView[] }>(r, "Failed to load the publishes waiting for you"),
      ),
    select: (d) => d.requests,
    refetchInterval: (q) => (q.state.data?.requests.some((r) => r.state === "publishing") ? 5_000 : false),
  });
}

/**
 * "Publish publicly" on a review panel: the user's own confirm, carrying the
 * code the page's read handed it and the state of the panel's rights box
 * (RIGHTS_CONFIRMATION_LABEL). Every caller passes `rightsConfirmed` itself —
 * the hook never assumes the box was ticked — and an unticked one is refused
 * here, before anything is sent, with the route's own words (the route
 * refuses it too: `rights_not_confirmed`). A refusal (`code`: changed,
 * publishing, bad_confirm_code, rights_not_confirmed, …) is shown on the
 * panel, not toasted.
 */
export function useConfirmPublishRequest() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (v: { id: string; confirmCode: string; rightsConfirmed: boolean }) => {
      if (v.rightsConfirmed !== true) throw new CloudRouteError(RIGHTS_REQUIRED, 400, "rights_not_confirmed");
      const r = await sendJson(`/api/templates/cloud/publish-requests/${encodeURIComponent(v.id)}/confirm`, "POST", {
        confirmCode: v.confirmCode,
        rightsConfirmed: v.rightsConfirmed,
      });
      return readJson<{ ok: true; jobId: string }>(r, "Couldn't start the publish");
    },
    onSettled: () => void qc.invalidateQueries({ queryKey: templatesCloudKeys.publishRequests }),
  });
}

/** "Don't publish": the request is forgotten; nothing was sent anywhere. */
export function useDiscardPublishRequest() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      fetch(`/api/templates/cloud/publish-requests/${encodeURIComponent(id)}`, { method: "DELETE" }).then((r) => readJson<{ ok: true }>(r, "Couldn't discard it")),
    onSettled: () => void qc.invalidateQueries({ queryKey: templatesCloudKeys.publishRequests }),
  });
}

/** Hide a published template from the catalog, or show it again. The server retries a 5xx; a refusal carries `code`. */
export function useSetTemplateHidden() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { cloudId: string; hidden: boolean }) =>
      sendJson("/api/templates/cloud/visibility", "PATCH", v).then(
        (r) => readJson<{ template: MineTemplate }>(r, "Couldn't change the template's visibility"),
        // libi's own server didn't answer: the route may have run, so this is unknown too.
        () => {
          throw new CloudRouteError(VISIBILITY_OUTCOME_UNKNOWN_MESSAGE, 0, "outcome_unknown");
        },
      ),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: templatesCloudKeys.mine });
      // The catalog route notes a change made here and re-checks its copy (catalog-cache.ts#noteOwnCatalogChange).
      void qc.invalidateQueries({ queryKey: templateKeys.catalog });
    },
    // `outcome_unknown`: the change may have landed — not an error, and the re-read list says which.
    onError: (e: Error) => (e instanceof CloudRouteError && e.code === "outcome_unknown" ? toast.warning(e.message) : toast.error(e.message)),
  });
}

/** `GET /api/templates/cloud/mine`: `error` set means the catalog's list could not be read, and why — a code, never the site's words. */
export interface CloudMine {
  nickname: string | null;
  templates: MineTemplate[];
  /** Entries the site listed that libi couldn't read: still this key's templates. */
  dropped?: number;
  error?: MineErrorCode;
}

/**
 * The catalog's numbers and visibility for this install's published templates
 * ("Your templates"). Never errors for offline — the route answers empty with
 * `error` — and re-reads every 10 minutes while the page is open. Each read
 * spends the creator key against the site, so a view with nothing published
 * to show passes `enabled: false`: it still sees a cached answer, and never
 * asks (D5–D6 review M1).
 */
export function useCloudMine(options?: { enabled?: boolean }) {
  return useQuery({
    enabled: options?.enabled ?? true,
    queryKey: templatesCloudKeys.mine,
    queryFn: () => fetch("/api/templates/cloud/mine").then((r) => readJson<CloudMine>(r, "Failed to load your published templates")),
    staleTime: 60_000,
    refetchInterval: 10 * 60 * 1000,
  });
}

/**
 * Install (or update) a public template locally — the `template_install` job,
 * run to its end by the route. `version` is the one the card showed: the
 * install refuses a catalog that has moved on rather than install something
 * the user didn't see. The lists refresh from the route's SSE and from here.
 */
export function useInstallTemplate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { cloudId: string; version: number }) =>
      sendJson("/api/templates/cloud/install", "POST", v).then((r) =>
        readJson<{ ok: true; templateId: string; version: number; reinstalled: boolean }>(r, "Couldn't install the template"),
      ),
    onSuccess: () => void qc.invalidateQueries({ queryKey: templateKeys.all, predicate: (q) => q.queryKey[1] !== templateKeys.catalog[1] }),
    onError: (e: Error) => toast.error(installErrorCopy(e)),
  });
}

/**
 * What the install toast says. The route answers libi's own copy, chosen by
 * the install's code; anything else — libi's server not answering, a body
 * that isn't the route's — gets a fixed line, never the error's own text.
 */
export function installErrorCopy(e: Error): string {
  return e instanceof CloudRouteError ? e.message : "Couldn't install the template — libi's server didn't answer.";
}

/** Report a public template with one of the catalog's fixed reasons, and optional details (≤ 2000). The route's error is libi's own copy. */
export function useReportTemplate() {
  return useMutation({
    mutationFn: (v: { cloudId: string; reason: ReportReason; details?: string }) =>
      sendJson("/api/templates/cloud/report", "POST", v).then((r) => readJson<{ ok: true; hidden: boolean }>(r, "Couldn't send the report")),
    onError: (e: Error) => toast.error(e.message),
  });
}

/**
 * `GET /api/templates/cloud/catalog/<cloudId>`: a public template's page — the
 * catalog's document (`uses30d` / `lastUsedDay` only from a site that sends
 * them), its scaffold (read without installing), the bucket folder its file
 * assets resolve against, and the local copy this machine has, if any.
 */
export interface PublicTemplateDetail {
  template: CloudTemplate;
  scaffold: TemplateScaffold;
  /** Assets the install's own check refused: left out of `scaffold`, never shown. */
  droppedAssets: number;
  mediaBase: string;
  installedTemplateId: string | null;
  /** `installed` (an installed copy) or `local` (the user's own published template); null with no local row. */
  installedOrigin: "installed" | "local" | null;
}

/** How long a public template's page data is trusted: its version's scaffold never changes, its numbers move slowly. */
const PUBLIC_DETAIL_STALE_MS = 5 * 60_000;

/** Said while the catalog's limit holds a template's page back. */
export const PUBLIC_DETAIL_RATE_LIMITED = "The catalog asked libi to slow down. Try again in a minute.";

/**
 * Until when NO public template's page may ask again: set from the route's
 * 429 (`Retry-After`, the site's limit passed through). The site limits per
 * CLIENT, so one backoff covers every template (fix-round review N5): any
 * page's read before then — a `refresh_query templates` after an install, a
 * focus, a Retry, another template's page — is answered from here without a
 * request, and the site's 10-a-minute budget (shared with installs) recovers.
 * The server keeps the same backoff for every window (catalog-detail.ts).
 */
let rateLimitedUntil = 0;

/** Forget the backoff: a switch of catalog (lib/queries/templates-catalog.ts) — the other site's limit is its own — and tests. */
export function resetPublicDetailBackoff(): void {
  rateLimitedUntil = 0;
}

/** Tests only. */
export function __resetPublicDetailBackoffForTests(): void {
  resetPublicDetailBackoff();
}

/**
 * A public template's page data. Never retried on a 400, 403, 404 (not an
 * id, not this page, no longer in the catalog) or 429 (the catalog's limit:
 * backed off instead, above); the error's `status` says which.
 */
export function usePublicTemplateDetail(cloudId: string) {
  return useQuery({
    queryKey: templatesCloudKeys.detail(cloudId),
    queryFn: async () => {
      if (Date.now() < rateLimitedUntil) throw new CloudRouteError(PUBLIC_DETAIL_RATE_LIMITED, 429, "rate_limited");
      const r = await fetch(`/api/templates/cloud/catalog/${encodeURIComponent(cloudId)}`);
      if (r.status === 429) {
        const sec = Number(r.headers.get("retry-after"));
        rateLimitedUntil = Math.max(rateLimitedUntil, Date.now() + (Number.isFinite(sec) && sec > 0 ? Math.min(sec, CATALOG_RETRY_AFTER_CAP_SEC) : 60) * 1000);
      }
      return readJson<PublicTemplateDetail>(r, "Couldn't load this template");
    },
    staleTime: PUBLIC_DETAIL_STALE_MS,
    retry: (n, e) => !(e instanceof CloudRouteError && [400, 403, 404, 429].includes(e.status)) && n < 2,
  });
}
