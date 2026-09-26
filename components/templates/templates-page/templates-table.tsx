"use client";

import { PRODUCTION_SITE_URL } from "@/lib/site-url";
import { catalogHost } from "@/lib/templates/cloud/catalog-origin";
import { useState } from "react";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { SortHead, sortRows, type SortState } from "@/components/social/social-page/list-views";
import { templatePageHref } from "@/components/templates/templates-page/template-card";
import { TemplateVisibility } from "@/components/templates/templates-page/template-visibility";
import { UsesSparkline } from "@/components/templates/templates-page/uses-sparkline";
import { useCloudMine, type CloudMine } from "@/lib/queries/templates-cloud";
import type { MineTemplate } from "@/lib/templates/cloud/client";
import type { TemplateSummary } from "@/lib/templates/types";

type Key = "uses7d" | "usesTotal" | "lastUsedAt";

/**
 * One line of "Your templates": a local template, joined with its `/mine`
 * entry when this install published it — or a `/mine` entry alone, for a
 * template published under this creator key whose local copy isn't here
 * (another machine, or deleted). The catalog's numbers win for a published
 * template: they count everyone's uses, not just this machine's.
 */
interface Row {
  key: string;
  name: string;
  local: TemplateSummary | null;
  cloud: MineTemplate | null;
  uses7d: number;
  usesTotal: number;
  lastUsedAt: string | null;
}

/**
 * The `/mine` entries with no local copy among `known` — the WHOLE local
 * library, never a filtered page of it: a local template a search left out
 * is still on this machine, and must not come back as "Not on this machine".
 */
export function cloudOnlyEntries(known: TemplateSummary[], mine: MineTemplate[] | undefined): MineTemplate[] {
  const here = new Set(known.map((r) => r.cloudId).filter((c): c is string => c !== null));
  return (mine ?? []).filter((m) => !here.has(m.id));
}

function joinRows(local: TemplateSummary[], mine: MineTemplate[] | undefined, cloudOnly: MineTemplate[]): Row[] {
  const byCloudId = new Map((mine ?? []).map((t) => [t.id, t]));
  const rows: Row[] = local.map((r) => {
    // Any row whose catalog id `/mine` lists is this creator's — including one
    // installed from the catalog on a machine that imported the key.
    const cloud = r.cloudId ? (byCloudId.get(r.cloudId) ?? null) : null;
    // One row per catalog entry carries its numbers and control.
    if (cloud) byCloudId.delete(cloud.id);
    return {
      key: r.id ?? r.cloudId ?? r.name,
      name: r.name,
      local: r,
      cloud,
      uses7d: cloud?.uses7d ?? r.uses7d,
      usesTotal: cloud?.usesTotal ?? r.usesTotal,
      lastUsedAt: r.lastUsedAt,
    };
  });
  for (const cloud of cloudOnly) {
    rows.push({ key: `cloud:${cloud.id}`, name: cloud.name, local: null, cloud, uses7d: cloud.uses7d, usesTotal: cloud.usesTotal, lastUsedAt: null });
  }
  return rows;
}

/**
 * Why the catalog's side of the table is missing, said by its cause: "can't
 * reach" only when nothing answered — a refused key or a bad answer is not
 * the user's connection. `routeFailed` is libi's own route not answering.
 */
function mineUnavailableCopy(error: CloudMine["error"], routeFailed: boolean): string {
  const tail = "published templates show this machine’s uses only.";
  if (routeFailed) return `Couldn’t load the catalog’s numbers — ${tail}`;
  switch (error) {
    case "unreachable":
      return `Can’t reach the catalog right now — ${tail}`;
    case "unauthorized":
      return `The catalog didn’t accept this install’s creator key — ${tail}`;
    default:
      return `The catalog couldn’t list your published templates right now — ${tail}`;
  }
}

/** What a row is: published (its visibility and control), installed from the catalog, or local only. */
function StatusCell({ row, minePending }: { row: Row; minePending: boolean }) {
  if (row.cloud)
    return (
      <span className="flex flex-col gap-0.5">
        <TemplateVisibility template={row.cloud} />
        {!row.local && (
          <span className="text-[0.65rem] text-muted-foreground" data-testid="templates-table-not-here">
            Not on this machine
          </span>
        )}
      </span>
    );
  const r = row.local!;
  // Linked to another catalog (test mode ⇄ a normal boot, or a dev build's production ⇄ development):
  // here it is a local copy, and says where it came from.
  const other = r.otherCatalog ? (
    <span className="text-[0.65rem] text-muted-foreground" data-testid="templates-table-other-catalog" title={r.otherCatalog === "test-mode" ? undefined : r.otherCatalog}>
      {otherCatalogLabel(r.otherCatalog)}
    </span>
  ) : null;
  if (r.origin === "installed")
    return (
      <span className="flex flex-col gap-0.5">
        <Badge variant="outline" className="text-[0.65rem]" data-testid="templates-table-installed">
          Installed
        </Badge>
        {other}
      </span>
    );
  if (r.cloudId) {
    // Published from here, but the catalog's list has no word on it yet —
    // still loading, unreachable, or it answered without this template.
    if (minePending) return <Skeleton className="h-4 w-16" />;
    return (
      <span className="text-xs text-muted-foreground" data-testid="templates-table-published">
        Published
      </span>
    );
  }
  return (
    <span className="flex flex-col gap-0.5">
      <span className="text-xs text-muted-foreground">Local</span>
      {other}
    </span>
  );
}

/**
 * "Your templates": every local template with its use counts, sortable, and
 * the catalog's side of the ones this install published (`/mine`): everyone's
 * uses, a 30-day sparkline, and the visibility control — Hide, Show again,
 * Hide again after a hide that didn't finish, or "Hidden by moderation" with
 * no control. Offline, the local numbers stand and the table says so.
 */
export function TemplatesTable({
  rows,
  known = rows,
  cloudOnlyFilter,
  className = "mt-8",
}: {
  /** The local rows to list (the toolbar's filtered set in List view). */
  rows: TemplateSummary[];
  /** The whole local library, for which published templates have a copy here. Defaults to `rows`. */
  known?: TemplateSummary[];
  /** Which of the published-but-not-here entries to list (the toolbar's filter). Default: all. */
  cloudOnlyFilter?: (m: MineTemplate) => boolean;
  className?: string;
}) {
  const [sort, setSort] = useState<SortState<Key> | null>({ key: "uses7d", dir: "desc" });
  const mine = useCloudMine();
  const away = cloudOnlyEntries(known, mine.data?.templates);
  const joined = joinRows(rows, mine.data?.templates, cloudOnlyFilter ? away.filter(cloudOnlyFilter) : away);
  const value = (r: Row): number | undefined =>
    sort?.key === "lastUsedAt" ? (r.lastUsedAt ? Date.parse(r.lastUsedAt) : undefined) : sort ? r[sort.key] : undefined;
  const sorted = sort ? sortRows(joined, sort.dir, value) : joined;
  const mineUnavailable = mine.isError || !!mine.data?.error;
  const anyPublished = rows.some((r) => r.origin === "local" && r.cloudId);
  return (
    <section className={className}>
      {/* "Your templates" is the name Terms §11 gives this screen — keep the heading. */}
      <h2 className="mb-2 text-sm font-semibold">Your templates</h2>
      {mineUnavailable && anyPublished && (
        <p className="mb-2 text-xs text-amber-500" data-testid="templates-table-mine-offline">
          {mineUnavailableCopy(mine.data?.error, mine.isError)}
        </p>
      )}
      <div className="overflow-x-auto rounded-xl border border-border">
        <Table data-testid="templates-table">
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Status</TableHead>
              <SortHead label="7 days" k="uses7d" sort={sort} onSort={setSort} />
              <SortHead label="Total" k="usesTotal" sort={sort} onSort={setSort} />
              <TableHead>30 days</TableHead>
              <SortHead label="Last used" k="lastUsedAt" sort={sort} onSort={setSort} />
            </TableRow>
          </TableHeader>
          <TableBody>
            {sorted.map((r) => (
              <TableRow
                key={r.key}
                data-testid="templates-table-row"
                data-template-id={r.local?.id ?? undefined}
                data-cloud-id={r.cloud?.id ?? undefined}
              >
                <TableCell className="max-w-64 truncate text-sm">
                  {r.local?.id ? (
                    <Link href={templatePageHref(r.local.id)} className="cursor-pointer hover:underline" data-testid="templates-table-name">
                      <bdi>{r.name}</bdi>
                    </Link>
                  ) : (
                    <bdi>{r.name}</bdi>
                  )}
                </TableCell>
                <TableCell>
                  <StatusCell row={r} minePending={mine.isPending} />
                </TableCell>
                <TableCell className="text-right tabular-nums">{r.uses7d}</TableCell>
                <TableCell className="text-right tabular-nums">{r.usesTotal}</TableCell>
                <TableCell>{r.cloud ? <UsesSparkline byDay={r.cloud.byDay} /> : null}</TableCell>
                <TableCell className="text-right text-xs text-muted-foreground">
                  {r.lastUsedAt ? new Date(r.lastUsedAt).toLocaleDateString() : "—"}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </section>
  );
}

/** Where a template linked to another catalog came from, in the Your templates table. */
export function otherCatalogLabel(source: string): string {
  if (source === "test-mode") return "From the test-mode catalog";
  if (source === PRODUCTION_SITE_URL) return "From the production catalog";
  return `From the development catalog (${catalogHost(source)})`;
}
