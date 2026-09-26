"use client";

/**
 * The Templates page's only data path (spec §7). Every read goes through
 * `/api/templates`; the live refresh rides libi's ONE SSE connection as
 * `refresh_query { queryKey: "templates" }` → `dispatchRefreshQueryData`, so
 * nothing here polls and nothing here opens an EventSource.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { CatalogIndexResponse, TemplateSummary, TemplateOrder, TemplateScope } from "@/lib/templates/types";
import type { TemplateScaffold } from "@/lib/templates/scaffold";

export interface TemplateListParams {
  q?: string;
  tags?: string[];
  order?: TemplateOrder;
  scope?: TemplateScope;
}

export const templateKeys = {
  all: ["templates"] as const,
  list: (p: TemplateListParams) => ["templates", "list", p] as const,
  detail: (id: string) => ["templates", "detail", id] as const,
  catalog: ["templates", "catalog"] as const,
  /** Under `templates`, so the runner's `refresh_query templates` re-reads it when a render ends. */
  renderingExamples: ["templates", "examples", "rendering"] as const,
};

/** How often the in-flight example renders are re-read while any is running. */
const RENDERING_POLL_MS = 2000;

const CATALOG_REFRESH_MS = 10 * 60 * 1000;
/**
 * While one of this install's own publishes, hides or shows isn't in the copy
 * yet (the route's `ownChanges`): the route re-checks the site at most this
 * often (catalog-cache.ts#OWN_CHANGE_RECHECK_MS), so asking more often gains nothing.
 */
export const CATALOG_OWN_CHANGE_POLL_MS = 60 * 1000;

/** A template's use on this machine: every use, the last 7 and 30 days, and when it was last used. */
export interface TemplateLocalUsage {
  total: number;
  d7: number;
  d30: number;
  lastUsedAt: string | null;
}

export interface TemplateDetail {
  template: TemplateSummary;
  /** null when the folder failed validation — `template.broken` says why. */
  scaffold: TemplateScaffold | null;
  instructions: string;
  usage: TemplateLocalUsage;
}

/** A non-2xx answer from one of these routes, with its status (the template's page tells 404 apart). */
export class TemplatesHttpError extends Error {
  constructor(readonly status: number) {
    super(`HTTP ${status}`);
    this.name = "TemplatesHttpError";
  }
}

function listUrl(p: TemplateListParams): string {
  const sp = new URLSearchParams();
  sp.set("order", p.order ?? "trending");
  if (p.scope) sp.set("scope", p.scope);
  const q = (p.q ?? "").trim();
  if (q.length >= 2) sp.set("q", q);
  if (p.tags?.length) sp.set("tags", p.tags.join(","));
  return `/api/templates?${sp.toString()}`;
}

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  if (!res.ok) throw new TemplatesHttpError(res.status);
  return res.json() as Promise<T>;
}

/** The page's list. Refreshed by `refresh_query templates` over the one SSE. */
export function useTemplates(params: TemplateListParams = {}) {
  const normalized: TemplateListParams = {
    order: params.order ?? "trending",
    ...(params.scope ? { scope: params.scope } : {}),
  };
  return useQuery({
    queryKey: templateKeys.list(normalized),
    queryFn: async () => (await api<{ templates: TemplateSummary[] }>(listUrl(normalized))).templates,
  });
}

/** Search + tag filter, on the same endpoint. A `q` under 2 chars is not sent
 *  — the server lists. Debouncing the user's keystrokes is the caller's job.
 *
 *  Every keystroke past the debounce and every tag toggle is a NEW query key
 *  with nothing cached, so without `placeholderData` the grid would drop to a
 *  skeleton between each one. Keeping the previous result means the cards stay
 *  put and only dim while the next answer is on its way — the page reads
 *  `isPlaceholderData` to say so. */
export function useTemplateSearch(params: TemplateListParams) {
  const q = (params.q ?? "").trim();
  const normalized: TemplateListParams = {
    order: params.order ?? "trending",
    ...(params.scope ? { scope: params.scope } : {}),
    ...(q.length >= 2 ? { q } : {}),
    ...(params.tags?.length ? { tags: params.tags } : {}),
  };
  return useQuery({
    queryKey: templateKeys.list(normalized),
    queryFn: async () => (await api<{ templates: TemplateSummary[] }>(listUrl(normalized))).templates,
    placeholderData: (prev) => prev,
  });
}

/**
 * The cached public catalog. Asking IS the refresh: the route re-fetches the
 * index when its copy is older than 10 minutes, so this polls every 10 minutes
 * while a page that uses it is open. Offline still answers 200 with the last
 * copy and `error`. When a fetch brought a new index, the OTHER templates
 * queries are invalidated: the public search reads the same cache. This one
 * is left out — it is mid-fetch then, and on a background refetch (data
 * already there) invalidating it would cancel this fetch and send a second.
 * While the answer carries `ownChanges` (a publish, hide or show made here
 * that the copy doesn't show yet) it polls every minute instead, so the
 * template joins the list as soon as the site's edge cache lets it.
 */
export function useCatalogIndex() {
  const qc = useQueryClient();
  return useQuery({
    queryKey: templateKeys.catalog,
    queryFn: async () => {
      const json = await api<CatalogIndexResponse>("/api/templates/cloud/catalog");
      if (json.refreshed) {
        void qc.invalidateQueries({ queryKey: templateKeys.all, predicate: (q) => q.queryKey[1] !== templateKeys.catalog[1] });
      }
      return json;
    },
    refetchInterval: (q) => ((q.state.data?.ownChanges?.length ?? 0) > 0 ? CATALOG_OWN_CHANGE_POLL_MS : CATALOG_REFRESH_MS),
    staleTime: 60_000,
  });
}

/**
 * The Public tab's Refresh: a forced catalog fetch, past the freshness window
 * and the failure backoff (POST /api/templates/cloud/catalog). Its answer is
 * the catalog query's new value; a new index refreshes the lists like a
 * polled one does.
 */
export function useRefreshCatalog() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api<CatalogIndexResponse>("/api/templates/cloud/catalog", { method: "POST" }),
    onSuccess: (json) => {
      qc.setQueryData(templateKeys.catalog, json);
      if (json.refreshed) {
        void qc.invalidateQueries({ queryKey: templateKeys.all, predicate: (q) => q.queryKey[1] !== templateKeys.catalog[1] });
      }
    },
  });
}

/** One local template: its summary, scaffold, instructions and use on this machine (the template's page). A 404 is not retried. */
export function useTemplate(id: string | null, options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: templateKeys.detail(id ?? ""),
    queryFn: () => api<TemplateDetail>(`/api/templates/${encodeURIComponent(id!)}`),
    enabled: !!id && (options?.enabled ?? true),
    retry: (n, e) => !(e instanceof TemplatesHttpError && e.status === 404) && n < 2,
  });
}

export function useDeleteTemplate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch(`/api/templates/${encodeURIComponent(id)}`, { method: "DELETE" });
      const body = (await res.json().catch(() => ({}))) as { ok?: true; note?: string; message?: string };
      // 409: a publish of it is still running — the server says what to do instead.
      if (!res.ok) throw new Error(body.message ?? `HTTP ${res.status}`);
      return body as { ok: true; note?: string };
    },
    // Everything under `templates` re-reads — except the deleted template's own page query:
    // re-read, it answers 404 and the page flashed "isn't on this machine any more" before
    // the page navigated away (D5–D6 review M8). It is dropped once nothing shows it.
    onSuccess: (_r, id) => {
      const gone = templateKeys.detail(id);
      qc.invalidateQueries({ queryKey: templateKeys.all, predicate: (q) => !(q.queryKey[1] === gone[1] && q.queryKey[2] === gone[2]) });
    },
  });
}

/**
 * "Render preview": start the `template_example` job for a local template
 * (POST /api/templates/<id>/example). The server's refusal (the source piece
 * is gone; an installed template) comes back as the error's message.
 */
export function useRenderExample() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (templateId: string) => {
      const res = await fetch(`/api/templates/${encodeURIComponent(templateId)}/example`, { method: "POST" });
      const body = (await res.json().catch(() => ({}))) as { jobId?: string; error?: string };
      if (!res.ok || !body.jobId) throw new Error(res.status === 404 ? "This template no longer exists." : (body.error ?? `HTTP ${res.status}`));
      return { jobId: body.jobId };
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: templateKeys.renderingExamples });
    },
  });
}

/** Where the templates' example renders stand (`GET /api/templates/examples/rendering`). */
export interface RenderingExamples {
  /** Templates with a render queued or running. */
  templateIds: string[];
  /** Templates whose last render failed, and why. */
  failed: Array<{ templateId: string; error: string }>;
}

/**
 * The templates with an example render in flight, whoever started it (the
 * agent's create, or Render preview), and the ones whose last render failed.
 * Re-read every 2 s only while one is running — so a render that fails is
 * seen ending — and on every `refresh_query templates` (the key sits under
 * `templates`), which a finished render and the agent's create both send.
 */
export function useRenderingExamples() {
  return useQuery({
    queryKey: templateKeys.renderingExamples,
    queryFn: () => api<RenderingExamples>("/api/templates/examples/rendering"),
    refetchInterval: (q) => ((q.state.data?.templateIds.length ?? 0) > 0 ? RENDERING_POLL_MS : false),
  });
}

/** Poster / example / asset bytes. `name` is a BASENAME — the route looks an
 *  asset up under the template's `assets/`, and serves nothing else. */
export function templateMediaUrl(id: string, name: string): string {
  return `/api/templates/${encodeURIComponent(id)}/media/${encodeURIComponent(name)}`;
}

/** An ASSET's bytes, always from `assets/` — even one named `poster.jpg` or `example.mp4`,
 *  which `templateMediaUrl` would answer with the template's own poster or example (D5–D6 M6). */
export function templateAssetUrl(id: string, name: string): string {
  return `${templateMediaUrl(id, name)}?as=asset`;
}

/**
 * A template's canvas from any list this page's cache already holds (the
 * Templates page it came from), so its page's skeleton has the right shape
 * before the template itself arrives. Null when none has it.
 */
export function cachedTemplateCanvas(qc: ReturnType<typeof useQueryClient>, match: (t: TemplateSummary) => boolean): { width: number; height: number } | null {
  for (const [, data] of qc.getQueriesData<unknown>({ queryKey: templateKeys.all })) {
    if (!Array.isArray(data)) continue;
    const hit = (data as TemplateSummary[]).find((t) => t && typeof t === "object" && "canvas" in t && match(t));
    if (hit) return { width: hit.canvas.width, height: hit.canvas.height };
  }
  return null;
}
