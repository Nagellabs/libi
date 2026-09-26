"use client";

import Link from "next/link";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { publicTemplatePageHref, type PublicTemplate } from "@/components/templates/templates-page/public-template-card";
import { PublicUseButton } from "@/components/templates/templates-page/public-use-button";
import { ReportMenu } from "@/components/templates/templates-page/report-menu";

/** The most tags a row shows, as on the card; the catalog allows ten. */
const TAGS_SHOWN = 4;

/**
 * The Public tab's List view: the same (filtered) catalog entries as the
 * cards, one row each, with the cards' own actions — Use and Report. Everything
 * in a row is the author's text, rendered plain and bidi-isolated; the name
 * opens the template's own page.
 */
export function PublicTemplatesTable({ rows }: { rows: PublicTemplate[] }) {
  return (
    <div className="overflow-x-auto rounded-xl border border-border">
      <Table data-testid="public-templates-table">
        <TableHeader>
          <TableRow>
            <TableHead>Name</TableHead>
            <TableHead>Author</TableHead>
            <TableHead>Tags</TableHead>
            <TableHead className="text-right">Uses (7 d / total)</TableHead>
            <TableHead>
              <span className="sr-only">Actions</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((e) => (
            <TableRow key={e.cloudId} data-testid="public-templates-table-row" data-cloud-id={e.cloudId}>
              <TableCell className="max-w-64 truncate text-sm">
                <Link href={publicTemplatePageHref(e.cloudId)} className="cursor-pointer hover:underline">
                  <bdi>{e.name}</bdi>
                </Link>
              </TableCell>
              <TableCell className="max-w-40 truncate text-xs text-muted-foreground">
                <bdi>{e.nickname ?? "someone"}</bdi>
              </TableCell>
              <TableCell>
                <span className="flex flex-wrap gap-1">
                  {e.tags.slice(0, TAGS_SHOWN).map((tag) => (
                    <span
                      key={tag}
                      data-testid="public-templates-table-tag"
                      className="max-w-32 truncate rounded-full border border-border px-1.5 text-[0.65rem] text-muted-foreground"
                    >
                      <bdi>{tag}</bdi>
                    </span>
                  ))}
                  {e.tags.length > TAGS_SHOWN && <span className="text-[0.65rem] text-muted-foreground">+{e.tags.length - TAGS_SHOWN}</span>}
                </span>
              </TableCell>
              <TableCell className="text-right tabular-nums" data-testid="public-templates-table-uses">
                {e.uses7d} / {e.usesTotal}
              </TableCell>
              <TableCell>
                <span className="flex items-center justify-end gap-1">
                  <PublicUseButton cloudId={e.cloudId} version={e.version} testId="public-templates-table-use" />
                  <ReportMenu cloudId={e.cloudId} />
                </span>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
