"use client";

import { useState } from "react";
import { ExternalLink, MoreVertical, Settings as SettingsIcon, Loader2 } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import type { McpServerUI } from "@/lib/queries/mcp-servers";
import {
  useUpdateMcpServer,
  useDeleteMcpServer,
  useMcpServerDependencies,
  useRetryMcpServer,
  useRetryDependency,
} from "@/lib/queries/mcp-servers";
import { DependencyChip, DependencyChipSkeleton } from "./dependency-chip";
import { McpEnvVarsDialog } from "./mcp-env-vars-dialog";
import { McpSetupDialog } from "./mcp-setup-dialog";
import { BUNDLED_MCP_SERVERS } from "@/mcp/registry/bundled";
import { deriveAggregateStatus } from "@/lib/settings/aggregate-status";
import { hasInstallFailure } from "@/lib/settings/install-failure";

const CORE_IDS = new Set(["libi"]);

function InstallStatusBadge({
  status,
  error,
  setupAction,
  onSetupClick,
}: {
  status: string;
  error: string | null;
  setupAction?: "install" | "repair" | null;
  onSetupClick?: () => void;
}) {
  if (status === "installed" || status === "not_required") {
    return <Badge variant="outline" className="border-green-600 text-green-600">Installed</Badge>;
  }
  if (status === "checking") {
    return <Badge variant="outline" className="border-yellow-600 text-yellow-600">Checking...</Badge>;
  }
  if (status === "pending") {
    if (setupAction === "repair" && onSetupClick) {
      return (
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger render={<span className="inline-flex" />}>
              <button
                type="button"
                onClick={onSetupClick}
                className="cursor-pointer inline-flex items-center rounded-md border border-red-600 px-2.5 py-0.5 text-xs font-semibold text-red-600 transition-colors hover:bg-red-500/10"
              >
                Setup failed
              </button>
            </TooltipTrigger>
            <TooltipContent>
              <p className="max-w-xs">Click to ask the agent to diagnose and repair.</p>
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      );
    }
    if (setupAction === "install" && onSetupClick) {
      return (
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger render={<span className="inline-flex" />}>
              <button
                type="button"
                onClick={onSetupClick}
                className="cursor-pointer inline-flex items-center rounded-md border border-yellow-600 px-2.5 py-0.5 text-xs font-semibold text-yellow-600 transition-colors hover:bg-yellow-500/10"
              >
                Setup required
              </button>
            </TooltipTrigger>
            <TooltipContent>
              <p className="max-w-xs">Click to ask the agent to install this.</p>
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      );
    }
    return (
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger render={<span className="inline-flex" />}>
            <Badge variant="outline" className="border-yellow-600 text-yellow-600">Setup required</Badge>
          </TooltipTrigger>
          <TooltipContent>
            <p className="max-w-xs">One or more dependencies aren&rsquo;t installed yet. Click the missing chip(s) below to install.</p>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    );
  }
  if (status === "needs_config") {
    return (
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger render={<span className="inline-flex" />}>
            <Badge variant="outline" className="border-yellow-600 text-yellow-600">Needs configuration</Badge>
          </TooltipTrigger>
          <TooltipContent>
            <p className="max-w-xs">{error ?? "Set required API keys to enable this server."}</p>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    );
  }
  if (status === "installing") {
    return (
      <Badge variant="outline" className="border-yellow-600 text-yellow-600 inline-flex items-center gap-1">
        <Loader2 className="size-3 animate-spin" />
        Installing...
      </Badge>
    );
  }
  if (status === "failed") {
    if (setupAction === "repair" && onSetupClick) {
      return (
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger render={<span className="inline-flex" />}>
              <button
                type="button"
                onClick={onSetupClick}
                className="cursor-pointer inline-flex items-center rounded-md border border-red-600 px-2.5 py-0.5 text-xs font-semibold text-red-600 transition-colors hover:bg-red-500/10"
              >
                Setup failed
              </button>
            </TooltipTrigger>
            <TooltipContent>
              <p className="max-w-xs">Click to ask the agent to diagnose and repair.</p>
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      );
    }
    return (
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger render={<span className="inline-flex" />}>
            <Badge variant="outline" className="border-red-600 text-red-600">Failed</Badge>
          </TooltipTrigger>
          <TooltipContent>
            <p className="max-w-xs">{error ?? "Unknown error"}</p>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    );
  }
  return null;
}

function DependencyChips({ id }: { id: string }) {
  const { data: deps, isLoading } = useMcpServerDependencies(id);
  const retryDep = useRetryDependency(id);
  if (isLoading || !deps) {
    return (
      <div className="flex flex-wrap gap-1.5">
        <DependencyChipSkeleton binary="…" />
      </div>
    );
  }
  if (deps.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5" data-testid="dependency-chips">
      {deps.map((d) => (
        <DependencyChip
          key={d.binary}
          {...d}
          onRetry={() => retryDep.mutate(d.binary)}
          retryPending={retryDep.isPending && retryDep.variables === d.binary}
        />
      ))}
    </div>
  );
}

interface McpServerCardProps {
  server: McpServerUI;
  onEdit?: (server: McpServerUI) => void;
}

export function McpServerCard({ server, onEdit }: McpServerCardProps) {
  const updateMcp = useUpdateMcpServer();
  const deleteMcp = useDeleteMcpServer();
  const retryMutation = useRetryMcpServer();

  const isCore = CORE_IDS.has(server.id);

  const [envDialogOpen, setEnvDialogOpen] = useState(false);
  const [setupDialogOpen, setSetupDialogOpen] = useState(false);

  const def = BUNDLED_MCP_SERVERS.find((d) => d.id === server.id);
  const requiredEnvVars = def?.requiredEnvVars ?? [];
  const showConfigureButton = server.bundled && requiredEnvVars.length > 0;
  const isPrimaryConfigure = server.installStatus === "needs_config";
  const isTier2 = (def?.installFlow ?? "tier-1") === "tier-2";

  const { data: depsForBadge } = useMcpServerDependencies(server.id);
  // Trust server.installStatus for terminal states the dep-aggregate can't
  // see (needs_config: env var missing; failed: install attempt errored).
  // Otherwise roll up live per-dep status so mid-flight transitions (chip
  // changes from pending → installing → installed) update the badge in
  // real time without waiting on the row-level settle to run.
  const aggregateStatus =
    server.installStatus === "needs_config" || server.installStatus === "failed"
      ? server.installStatus
      : depsForBadge && depsForBadge.length > 0
        ? deriveAggregateStatus(depsForBadge)
        : server.installStatus;

  const failureDetected =
    server.bundled && hasInstallFailure(server, depsForBadge);

  const setupAction: "install" | "repair" | null = !server.bundled
    ? null
    : failureDetected || aggregateStatus === "failed"
      ? "repair"
      : aggregateStatus === "pending"
        ? "install"
        : null;

  return (
    <>
    <Card id={`mcp-${server.id}`} data-testid={`mcp-card-${server.id}`}>
      <CardContent className="flex items-start justify-between gap-4 p-4">
        <div className="flex-1 min-w-0 space-y-2">
          <div className="flex items-center gap-2">
            <h3 className="font-medium truncate">{server.name}</h3>
            {isCore ? (
              <Badge variant="outline" className="border-primary text-primary">Core</Badge>
            ) : null}
            <InstallStatusBadge
              status={aggregateStatus}
              error={server.installError}
              setupAction={setupAction}
              onSetupClick={setupAction ? () => setSetupDialogOpen(true) : undefined}
            />
            {server.type === "http" && (
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger render={<span className="inline-flex" />}>
                    <span className="inline-flex items-center gap-1 rounded-full border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-[10px] font-medium text-amber-300">
                      BYO-CLI only
                    </span>
                  </TooltipTrigger>
                  <TooltipContent>
                    <p className="max-w-xs">
                      HTTP MCPs run via <code>npx @nagellabs/libi --connect-agent</code> + Claude Code; in-app ACP sessions skip them until upstream support lands.
                    </p>
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            )}
            {server.npmUrl && (
              <a
                href={server.npmUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-muted-foreground hover:text-foreground"
              >
                <ExternalLink className="size-3.5" />
              </a>
            )}
          </div>
          {server.description && (
            <p className="text-sm text-muted-foreground">{server.description}</p>
          )}
          {/* Tier-2 MCPs are agent-managed end-to-end — per-binary chips would
              require libi to track each binary's status the way Category A does,
              which it doesn't for tier-2 (the agent uses uv/npm/etc and doesn't
              write libi's install-token markers). Tier-1 MCPs (libi core) still
              show chips because their deps ARE libi-managed. */}
          {server.bundled && !isTier2 && <DependencyChips id={server.id} />}
          {!server.bundled && server.type === "stdio" && server.command && (
            <p className="text-xs text-muted-foreground font-mono">
              {server.command} {server.args ? JSON.parse(server.args).join(" ") : ""}
            </p>
          )}
          {!server.bundled && server.type === "http" && server.url && (
            <p className="text-xs text-muted-foreground font-mono">{server.url}</p>
          )}
          {/* Hide the "Server: …" line when there's no spawnable server
              (whisper/local-tts/local-music — `uv run` libraries) or when
              the install isn't ready (a probe never ran, so "unknown" or
              a stale "down" carries no information — the badge already
              tells the user the row needs config / install). */}
          {!isCore && !server.noServer &&
            (aggregateStatus === "installed" || aggregateStatus === "not_required") && (
            <div className="mt-2 flex items-center gap-2 text-xs">
              <span className="text-muted-foreground">Server:</span>
              <span
                className={cn(
                  "rounded px-1.5 py-0.5 font-medium",
                  server.serverStatus === "up" && "bg-green-500/15 text-green-400",
                  server.serverStatus === "down" && "bg-destructive/15 text-destructive",
                  (server.serverStatus === "unknown" || server.serverStatus === "starting") &&
                    "bg-muted text-muted-foreground",
                )}
              >
                {server.serverStatus}
              </span>
              {server.serverStatus === "down" && !isTier2 && (
                <button
                  type="button"
                  onClick={() => retryMutation.mutate(server.id)}
                  disabled={retryMutation.isPending}
                  className="cursor-pointer rounded border border-border px-2 py-0.5 hover:bg-muted disabled:opacity-50"
                >
                  {retryMutation.isPending ? "Retrying…" : "Retry"}
                </button>
              )}
            </div>
          )}
          {!isCore && !server.noServer &&
            (aggregateStatus === "installed" || aggregateStatus === "not_required") &&
            server.serverError && (
            <details className="mt-1 text-xs text-muted-foreground">
              <summary className="cursor-pointer">Last error</summary>
              <pre className="mt-1 max-h-32 overflow-auto rounded bg-muted/40 p-2 text-[11px]">
                {server.serverError}
              </pre>
            </details>
          )}
        </div>

        {!isCore && (
          <div className="flex flex-col items-end gap-3 shrink-0">
            {showConfigureButton && (
              <Button
                variant={isPrimaryConfigure ? "default" : "outline"}
                size="sm"
                className={`cursor-pointer ${isPrimaryConfigure ? "ring-2 ring-yellow-500/40" : ""}`}
                onClick={() => setEnvDialogOpen(true)}
              >
                <SettingsIcon className="size-3.5 mr-1.5" />
                {isPrimaryConfigure ? "Configure API Keys" : "API Keys"}
              </Button>
            )}
            <div className="flex items-center gap-2">
              <Label htmlFor={`enabled-${server.id}`} className="text-xs">Enable</Label>
              <Switch
                id={`enabled-${server.id}`}
                checked={server.enabled}
                onCheckedChange={(enabled) => updateMcp.mutate({ id: server.id, enabled })}
              />
            </div>
            <div className="flex items-center gap-2">
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Label htmlFor={`approval-${server.id}`} className="text-xs cursor-help">
                        Require approval
                      </Label>
                    }
                  />
                  <TooltipContent className="max-w-xs text-xs">
                    Agent asks before calling this server&rsquo;s tools. Enable this if those tools involve extra cost or take meaningful time.
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
              <Switch
                id={`approval-${server.id}`}
                checked={server.requireApproval}
                onCheckedChange={(requireApproval) =>
                  updateMcp.mutate({ id: server.id, requireApproval })
                }
              />
            </div>
            {!server.bundled && onEdit && (
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={
                    <button
                      type="button"
                      aria-label={`Actions for ${server.name}`}
                      className="cursor-pointer inline-flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                    />
                  }
                >
                  <MoreVertical className="size-3.5" />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" sideOffset={4}>
                  <DropdownMenuItem
                    className="cursor-pointer"
                    onClick={() => onEdit(server)}
                  >
                    Edit
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    variant="destructive"
                    className="cursor-pointer"
                    onClick={() => {
                      if (confirm(`Delete MCP server "${server.name}"?`)) {
                        deleteMcp.mutate(server.id);
                      }
                    }}
                  >
                    Delete
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>
        )}
      </CardContent>
    </Card>
      {showConfigureButton && (
        <McpEnvVarsDialog
          open={envDialogOpen}
          onOpenChange={setEnvDialogOpen}
          server={server}
          requiredEnvVars={requiredEnvVars}
        />
      )}
      {setupAction && (
        <McpSetupDialog
          open={setupDialogOpen}
          onOpenChange={setSetupDialogOpen}
          server={server}
          deps={depsForBadge}
          action={setupAction}
        />
      )}
    </>
  );
}
