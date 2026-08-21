"use client";

import type {
  VersionDiffResponse,
  EntityRefDTO,
} from "@/lib/queries/snapshots";
import { AlertTriangle } from "lucide-react";

interface Props {
  pieceId: string;
  data: VersionDiffResponse | undefined;
  isLoading: boolean;
  /** True when this is the oldest version in the timeline (diffed against an
   *  empty baseline) — the only case that warrants the "Initial version" heading. */
  isOldest: boolean;
}

function actorIcon(a: "agent" | "user") {
  return (
    <span aria-label={a === "agent" ? "agent" : "you"}>
      <span aria-hidden="true">{a === "agent" ? "🤖" : "👤"}</span>
    </span>
  );
}

function ChangeLine({
  sym,
  cls,
  children,
}: {
  sym: string;
  cls: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-baseline gap-2 text-sm">
      <span className={`w-4 font-bold ${cls}`}>{sym}</span>
      <span className="truncate">{children}</span>
    </div>
  );
}

/**
 * Presentational detail for the selected version: header (title + actor/time),
 * the scene filmstrip, the named changelog, and any missing-file warnings.
 * Actions (save/discard/restore) live in the modal's top toolbar, not here.
 */
export function VersionDetailPanel({ pieceId, data, isLoading, isOldest }: Props) {
  if (isLoading || !data) {
    return <div className="p-4 text-sm text-muted-foreground">Loading…</div>;
  }

  const { diff, missingFiles } = data;
  // "Initial version" only for the genuinely-oldest history row (diffed against
  // an empty baseline), not any later add-only commit.
  const isInitial = data.kind === "history" && isOldest;
  const title =
    data.kind === "draft"
      ? `Draft — ${diff.totalChanges} unsaved change${diff.totalChanges === 1 ? "" : "s"}`
      : (data.summary ?? "Untitled snapshot");
  const when = data.committedAt
    ? new Date(data.committedAt * 1000).toLocaleString()
    : "just now";

  return (
    <div className="flex h-full flex-col gap-4 overflow-y-auto p-4">
      <div>
        <h2 className="text-base font-semibold">{title}</h2>
        <p className="text-xs text-muted-foreground">
          {actorIcon(data.actor)} · {when}
        </p>
      </div>

      <section className="space-y-1">
        <h3 className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {data.kind === "draft"
            ? "Uncommitted changes"
            : isInitial
              ? "Initial version"
              : "What this save introduced"}
        </h3>
        {diff.totalChanges === 0 && (
          <div className="text-sm text-muted-foreground">
            No changes from the previous version.
          </div>
        )}
        {(
          [
            ...diff.overlays.added.map((o) => ["＋", "text-emerald-400", o] as [string, string, EntityRefDTO]),
            ...diff.overlays.removed.map((o) => ["−", "text-red-400", o] as [string, string, EntityRefDTO]),
            ...diff.overlays.changed.map((o) => ["~", "text-amber-400", o] as [string, string, EntityRefDTO]),
          ] as [string, string, EntityRefDTO][]
        ).map(([sym, cls, o]) => (
          <ChangeLine key={`o-${sym}-${o.id}`} sym={sym} cls={cls}>
            {o.kind} overlay · {o.label}
          </ChangeLine>
        ))}
        {(
          [
            ...diff.audioClips.added.map((c) => ["＋", "text-emerald-400", c] as [string, string, EntityRefDTO]),
            ...diff.audioClips.removed.map((c) => ["−", "text-red-400", c] as [string, string, EntityRefDTO]),
            ...diff.audioClips.changed.map((c) => ["~", "text-amber-400", c] as [string, string, EntityRefDTO]),
          ] as [string, string, EntityRefDTO][]
        ).map(([sym, cls, c]) => (
          <ChangeLine key={`c-${sym}-${c.id}`} sym={sym} cls={cls}>
            audio · {c.label}
          </ChangeLine>
        ))}
      </section>

      {missingFiles.length > 0 && (
        <section className="rounded-md border border-red-500/30 bg-red-500/5 p-2">
          <div className="flex items-center gap-1.5 text-xs font-medium text-red-400">
            <AlertTriangle className="h-3.5 w-3.5" />
            {(() => {
              // Distinct deleted files vs affected items: one deleted video file
              // breaks both its scene and its inline audio clip.
              const fileCount = new Set(missingFiles.map((m) => m.fileId)).size;
              const itemCount = missingFiles.length;
              return `${fileCount} referenced file${fileCount === 1 ? "" : "s"} deleted — ${itemCount} item${itemCount === 1 ? "" : "s"} won't render:`;
            })()}
          </div>
          <ul className="mt-1 space-y-0.5 pl-5 text-xs text-muted-foreground">
            {missingFiles.map((m) => (
              <li key={`${m.fileId}-${m.refKind}-${m.refName}`}>
                • {m.refName} ({m.refKind})
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
