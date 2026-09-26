"use client";

import Link from "next/link";
import { useTemplatesCatalog } from "@/lib/queries/templates-catalog";

/**
 * "Development catalog · <host>" beside the Templates heading whenever this
 * libi reads a development catalog — so a dev build's owner never publishes
 * to the wrong place by accident. In a dev build it links to the switch
 * (Settings → Templates). Nothing for the production catalog or test mode.
 */
export function DevelopmentCatalogBadge() {
  const { data } = useTemplatesCatalog();
  if (!data || data.active.kind !== "development") return null;
  const className =
    "inline-flex h-5 items-center rounded-4xl border border-amber-500/50 bg-amber-500/10 px-2 text-xs font-medium whitespace-nowrap text-amber-500";
  const label = `Development catalog · ${data.active.host}`;
  const title = `Browsing, installing and publishing against ${data.active.origin}`;
  return data.devBuild ? (
    <Link href="/settings?tab=templates" data-testid="templates-dev-catalog-badge" title={`${title} — switch in Settings → Templates`} className={`${className} cursor-pointer hover:bg-amber-500/20`}>
      {label}
    </Link>
  ) : (
    <span data-testid="templates-dev-catalog-badge" title={title} className={className}>
      {label}
    </span>
  );
}
