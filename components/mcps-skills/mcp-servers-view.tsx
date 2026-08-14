"use client";

import { useEffect, useState } from "react";
import { Download, Plus, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { McpServerCard } from "@/components/settings/mcp-server-card";
import { AddMcpDialog } from "@/components/settings/add-mcp-dialog";
import { InstallFromUrlDialog } from "@/components/mcps-skills/install-from-url-dialog";
import { useMcpServers, useResyncMcpServers } from "@/lib/queries/mcp-servers";
import type { McpServerUI } from "@/lib/queries/mcp-servers";
import { useResetServer } from "@/lib/queries/server-status";

interface McpServersViewProps {
  searchQuery: string;
  onClearSearch?: () => void;
}

function matchesQuery(server: McpServerUI, query: string): boolean {
  if (!query) return true;
  const q = query.toLowerCase();
  const name = (server.name ?? "").toLowerCase();
  const desc = (server.description ?? "").toLowerCase();
  const id = (server.id ?? "").toLowerCase();
  return name.includes(q) || desc.includes(q) || id.includes(q);
}

export function McpServersView({ searchQuery, onClearSearch }: McpServersViewProps) {
  const { data: servers, isLoading } = useMcpServers();
  const resync = useResyncMcpServers();
  const reset = useResetServer();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editServer, setEditServer] = useState<McpServerUI | null>(null);
  const [installFromUrlOpen, setInstallFromUrlOpen] = useState(false);

  const byNameAsc = (a: McpServerUI, b: McpServerUI) =>
    (a.name ?? "").localeCompare(b.name ?? "", undefined, { sensitivity: "base" });

  const LIBI_IDS = new Set([
    "libi",
    "libi-tracking",
    "local-music",
    "local-tts",
    "whisper",
    "fake-ai-assets",
  ]);
  const allLibi =
    servers?.filter((s) => s.bundled && LIBI_IDS.has(s.id)).slice().sort(byNameAsc) ?? [];
  const allBundled =
    servers
      ?.filter((s) => s.bundled && !LIBI_IDS.has(s.id))
      .slice()
      .sort(byNameAsc) ?? [];
  const allCustom = servers?.filter((s) => !s.bundled).slice().sort(byNameAsc) ?? [];

  const trimmedQuery = searchQuery.trim();
  const libi = allLibi.filter((s) => matchesQuery(s, trimmedQuery));
  const bundled = allBundled.filter((s) => matchesQuery(s, trimmedQuery));
  const custom = allCustom.filter((s) => matchesQuery(s, trimmedQuery));

  const hasFailed = allBundled.some((s) => s.installStatus === "failed");

  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as { mcpId?: string };
      if (!detail?.mcpId) return;
      const card = document.querySelector(`#mcp-${CSS.escape(detail.mcpId)}`);
      if (!card) return;
      card.scrollIntoView({ behavior: "smooth", block: "start" });
      card.classList.add("ring-2", "ring-yellow-500/60");
      setTimeout(() => card.classList.remove("ring-2", "ring-yellow-500/60"), 1500);
    };
    window.addEventListener("libi:mcp-scroll-to", handler);
    return () => window.removeEventListener("libi:mcp-scroll-to", handler);
  }, []);

  function handleEdit(server: McpServerUI) {
    setEditServer(server);
    setDialogOpen(true);
  }

  function handleDialogChange(open: boolean) {
    setDialogOpen(open);
    if (!open) setEditServer(null);
  }

  if (isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-24 w-full" />
      </div>
    );
  }

  const allEmpty = libi.length === 0 && bundled.length === 0 && custom.length === 0;
  const showCrossSectionEmpty = trimmedQuery.length > 0 && allEmpty;

  return (
    <div className="space-y-8">
      <div className="flex flex-col items-end gap-1">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => reset.mutate()}
            disabled={reset.isPending}
            className="inline-flex items-center gap-1 rounded-md border border-border bg-background px-3 py-1.5 text-sm hover:bg-accent cursor-pointer disabled:opacity-60"
          >
            <RefreshCw className={`size-3.5 ${reset.isPending ? "animate-spin" : ""}`} />
            Restart server
          </button>
          {hasFailed && (
            <Button
              variant="outline"
              size="sm"
              className="cursor-pointer"
              onClick={() => resync.mutate()}
              disabled={resync.isPending}
            >
              <RefreshCw className={`size-3.5 mr-1.5 ${resync.isPending ? "animate-spin" : ""}`} />
              Resync
            </Button>
          )}
          <Button
            variant="outline"
            size="sm"
            className="cursor-pointer"
            onClick={() => setInstallFromUrlOpen(true)}
          >
            <Download className="size-3.5 mr-1.5" />
            Install from GitHub
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="cursor-pointer"
            onClick={() => setDialogOpen(true)}
          >
            <Plus className="size-3.5 mr-1.5" />
            Add MCP
          </Button>
        </div>
        <p className="text-xs text-muted-foreground italic">
          Or ask your agent to add an MCP to Libi
        </p>
      </div>

      {showCrossSectionEmpty ? (
        <div className="flex flex-col items-center justify-center gap-3 py-12 text-center">
          <p className="text-sm text-muted-foreground">
            Nothing matches &ldquo;{trimmedQuery}&rdquo;
          </p>
          {onClearSearch && (
            <Button
              variant="outline"
              size="sm"
              className="cursor-pointer"
              onClick={onClearSearch}
            >
              Clear search
            </Button>
          )}
        </div>
      ) : null}

      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-medium text-muted-foreground uppercase tracking-wide">Libi</h2>
        </div>
        {libi.length === 0 ? (
          <p className="text-sm text-muted-foreground">No matches in libi servers.</p>
        ) : (
          <div className="space-y-2">
            {libi.map((server) => (
              <McpServerCard key={server.id} server={server} />
            ))}
          </div>
        )}
      </section>

      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-medium text-muted-foreground uppercase tracking-wide">Bundled</h2>
        </div>
        {bundled.length === 0 ? (
          <p className="text-sm text-muted-foreground">No matches in bundled servers.</p>
        ) : (
          <div className="space-y-2">
            {bundled.map((server) => (
              <McpServerCard key={server.id} server={server} />
            ))}
          </div>
        )}
      </section>

      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-medium text-muted-foreground uppercase tracking-wide">Custom</h2>
        </div>
        {custom.length === 0 ? (
          <p className="text-sm text-muted-foreground">No matches in custom servers.</p>
        ) : (
          <div className="space-y-2">
            {custom.map((server) => (
              <McpServerCard key={server.id} server={server} onEdit={handleEdit} />
            ))}
          </div>
        )}
      </section>

      <AddMcpDialog open={dialogOpen} onOpenChange={handleDialogChange} editServer={editServer} />
      <InstallFromUrlDialog
        open={installFromUrlOpen}
        onOpenChange={setInstallFromUrlOpen}
        defaultKind="mcp"
      />
    </div>
  );
}
