import { utcDateLabel } from "@/lib/templates/details";
import { formatRelativeTime } from "@/lib/utils/format";

const times = (n: number) => `${n} ${n === 1 ? "time" : "times"}`;

/**
 * How much a template is used: on this machine (`local`: from libi's own
 * use rows), and in the public catalog (`catalog`: a published template's
 * `/mine` entry, or a public entry's document). `d30` is null — and the line
 * shows 7 days and the total only — when the catalog didn't say (a site
 * older than its 30-day figures); `lastUsedDay` is a UTC day, `YYYY-MM-DD`,
 * shown as "24 Sep 2026 (UTC)" like the takedown date.
 */
export function UsagePanel(props: {
  local?: { total: number; d7: number; d30: number; lastUsedAt: string | null };
  catalog?: { total: number; d7: number; d30: number | null; lastUsedDay: string | null };
}) {
  const { local, catalog } = props;
  if (!local && !catalog) return null;
  return (
    <div className="space-y-1.5 rounded-lg border border-border bg-card/50 px-3 py-2.5 text-xs text-muted-foreground tabular-nums" data-testid="usage-panel">
      {local && (
        <p data-testid="usage-local">
          <span className="font-medium text-foreground">Used {times(local.total)} on this machine</span>
          {" · "}
          {local.d7} in 7 days · {local.d30} in 30 days
          {local.lastUsedAt && <> · last used {formatRelativeTime(local.lastUsedAt)}</>}
        </p>
      )}
      {catalog && (
        <p data-testid="usage-catalog">
          <span className="font-medium text-foreground">In the catalog</span>
          {": "}
          {catalog.d7} in 7 days
          {catalog.d30 !== null && <> · {catalog.d30} in 30 days</>} · {catalog.total} total
          {catalog.lastUsedDay && utcDateLabel(catalog.lastUsedDay) && <> · last used {utcDateLabel(catalog.lastUsedDay)}</>}
        </p>
      )}
    </div>
  );
}
