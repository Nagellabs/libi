"use client";

/**
 * Which public templates catalog this libi reads, and — a dev build — its
 * Catalog setting (Settings → Templates): GET/PUT
 * /api/templates/cloud/catalog-setting. The bypass token never enters this
 * cache: the view says only whether one is set, and the token the user types
 * is sent once, in the mutation's body.
 *
 * A switch changes what every cloud-derived query means (catalog ids differ
 * between catalogs), so the mutation cancels whatever is in flight and
 * resets them all — the templates lists and pages, `/mine`, pending
 * publishes and publish requests, the creator's approval, and the public
 * page's rate-limit backoff — rather than letting an answer from the old
 * catalog land under the new one. Other windows follow through the
 * `refresh_query` events the route emits on libi's one SSE connection.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { legalLinksFor, LEGAL_LINKS, type LegalLinks } from "@/lib/legal-links";
import { templateKeys } from "@/lib/queries/templates";
import { CloudRouteError, resetPublicDetailBackoff, templatesCloudKeys } from "@/lib/queries/templates-cloud";
import { TEMPLATES_CATALOG_REFRESH_KEY } from "@/lib/templates/cloud/constants";
import type { TemplatesCatalogView } from "@/lib/templates/types";

export const templatesCatalogKeys = {
  view: [TEMPLATES_CATALOG_REFRESH_KEY] as const,
};

const URL_ = "/api/templates/cloud/catalog-setting";

async function readView(res: Response, fallback: string): Promise<TemplatesCatalogView> {
  const json = (await res.json().catch(() => ({}))) as TemplatesCatalogView & { error?: unknown; code?: unknown };
  if (!res.ok) throw new CloudRouteError(typeof json.error === "string" ? json.error : fallback, res.status, typeof json.code === "string" ? json.code : undefined);
  // Not a view (an older server, a proxy's page): an error, never a half-read view.
  if (typeof json.devBuild !== "boolean" || typeof json.active?.kind !== "string") throw new CloudRouteError(fallback, res.status);
  return json;
}

export function useTemplatesCatalog() {
  return useQuery({
    queryKey: templatesCatalogKeys.view,
    queryFn: () => fetch(URL_).then((r) => readView(r, "Couldn't read the templates catalog setting")),
    staleTime: Infinity,
  });
}

export interface TemplatesCatalogChange {
  choice?: "production" | "development";
  devOrigin?: string;
  /** A string sets it, null clears it. */
  bypassToken?: string | null;
}

export function useSetTemplatesCatalog() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (change: TemplatesCatalogChange) =>
      fetch(URL_, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(change) }).then((r) => readView(r, "Couldn't save the catalog setting")),
    onSuccess: async (view, change) => {
      qc.setQueryData(templatesCatalogKeys.view, view);
      // Only a change of catalog invalidates what the templates pages show; a token or address alone does not.
      if (change.choice === undefined && change.devOrigin === undefined) return;
      await Promise.all([qc.cancelQueries({ queryKey: templateKeys.all }), qc.cancelQueries({ queryKey: templatesCloudKeys.creator })]);
      resetPublicDetailBackoff();
      void qc.resetQueries({ queryKey: templateKeys.all });
      void qc.resetQueries({ queryKey: templatesCloudKeys.creator });
    },
  });
}

/**
 * Terms, Privacy and the catalog's report form: the development catalog's
 * own site while it is active (a dev build), else production's — the build's
 * own site until the view has loaded.
 */
export function useLegalLinks(): LegalLinks {
  const { data } = useTemplatesCatalog();
  return data ? legalLinksFor(data.legalOrigin) : LEGAL_LINKS;
}
