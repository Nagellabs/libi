"use client";

import { useState } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  useExportDefaults,
  useUpdateExportDefaults,
  type ExportDefaultsValue,
} from "@/lib/queries/export-defaults";
import { pickDirectory, hasElectronBridge } from "@/lib/shell/client";

export function ExportTab() {
  const { data, isLoading } = useExportDefaults();
  const update = useUpdateExportDefaults();

  // Local form mirror so the user can edit before pressing Save. Seeded from
  // whatever the query already resolved at mount; the previous-state block
  // below folds in later arrivals.
  const [folder, setFolder] = useState<string | null>(data?.folder ?? null);
  const [format, setFormat] = useState<ExportDefaultsValue["format"]>(data?.format ?? "mp4");
  const [quality, setQuality] = useState<ExportDefaultsValue["quality"]>(
    data?.quality ?? "source",
  );

  // Mirror fresh server data into the form during render (React's
  // previous-state pattern) — React Query's structural sharing keeps `data`
  // referentially stable between identical fetches, so this only fires when
  // the defaults actually changed.
  const [prevData, setPrevData] = useState(data);
  if (data !== prevData) {
    setPrevData(data);
    if (data) {
      setFolder(data.folder);
      setFormat(data.format);
      setQuality(data.quality);
    }
  }

  const handleSave = async () => {
    await update.mutateAsync({ folder, format, quality });
  };

  const handlePickFolder = async () => {
    const picked = await pickDirectory(folder ?? data?.osDefaultFolder);
    if (picked === undefined) return; // no bridge — user uses the text input
    if (picked === null) return;
    setFolder(picked);
  };

  if (isLoading || !data) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-6 w-32" />
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
      </div>
    );
  }

  const effectiveFolder = folder ?? data.osDefaultFolder;
  const dirty =
    folder !== data.folder || format !== data.format || quality !== data.quality;

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <label className="text-sm font-medium">Default output folder</label>
        <p className="text-xs text-muted-foreground">
          Exports save here unless you pick a different folder in the export dialog.
          Defaults to <code className="rounded bg-muted/40 px-1">{data.osDefaultFolder}</code>{" "}
          on this machine. The folder is created automatically the first time you export to it.
        </p>
        <div className="flex items-center gap-2">
          <Input
            value={effectiveFolder}
            onChange={(e) => setFolder(e.target.value || null)}
            placeholder={data.osDefaultFolder}
            className="flex-1 font-mono text-xs"
          />
          {hasElectronBridge() ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={handlePickFolder}
              className="cursor-pointer"
            >
              Choose…
            </Button>
          ) : null}
          {folder !== null ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setFolder(null)}
              className="cursor-pointer"
            >
              Reset
            </Button>
          ) : null}
        </div>
      </div>

      <div className="space-y-2">
        <label className="text-sm font-medium">Default format</label>
        <div className="flex w-full overflow-hidden rounded-md border border-input bg-background sm:w-64">
          {(["mp4", "webm"] as const).map((v) => (
            <button
              key={v}
              type="button"
              onClick={() => setFormat(v)}
              className={
                "flex-1 cursor-pointer px-3 py-1.5 text-xs font-medium transition-colors " +
                (format === v
                  ? "bg-primary text-primary-foreground"
                  : "text-foreground hover:bg-muted/40")
              }
            >
              {v === "mp4" ? "MP4" : "WebM"}
            </button>
          ))}
        </div>
      </div>

      <div className="space-y-2">
        <label className="text-sm font-medium">Default quality</label>
        <div className="flex w-full overflow-hidden rounded-md border border-input bg-background sm:w-80">
          {(
            [
              ["source", "Source"],
              ["1080p", "1080p"],
              ["1440p", "1440p"],
              ["4k", "4K"],
            ] as const
          ).map(([v, label]) => (
            <button
              key={v}
              type="button"
              onClick={() => setQuality(v)}
              className={
                "flex-1 cursor-pointer px-3 py-1.5 text-xs font-medium transition-colors " +
                (quality === v
                  ? "bg-primary text-primary-foreground"
                  : "text-foreground hover:bg-muted/40")
              }
            >
              {label}
            </button>
          ))}
        </div>
        <p className="text-xs text-muted-foreground">
          &quot;Source&quot; preserves the composition&apos;s native dimensions — the safe default.
          Higher presets are useful when you need a fixed delivery resolution.
        </p>
      </div>

      <div className="flex items-center justify-end gap-2 border-t border-border pt-4">
        {update.isPending ? (
          <span className="text-xs text-muted-foreground">Saving…</span>
        ) : null}
        <Button
          onClick={handleSave}
          disabled={!dirty || update.isPending}
          className="cursor-pointer"
        >
          Save defaults
        </Button>
      </div>
    </div>
  );
}
