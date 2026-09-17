"use client";

import { useState } from "react";
import { ExternalLink, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Card, CardContent } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { useEditorState } from "@/lib/editor-state-context";
import type { McpServerUI } from "@/lib/queries/mcp-servers";
import {
  useUpdateMcpServer,
  useMcpServerDependencies,
  useRetryMcpServer,
  useRetryDependency,
  useRemoveExtension,
} from "@/lib/queries/mcp-servers";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { isRemovableExtension } from "@/lib/settings/removable-extensions";
import { DependencyChip, DependencyChipSkeleton } from "./dependency-chip";
import { McpSetupDialog } from "./mcp-setup-dialog";
import { EXTENSION_MCP_SERVERS } from "@/mcp/registry/bundled";
import { PROVIDER_CATALOG } from "@/lib/providers/catalog";
import { deriveAggregateStatus } from "@/lib/settings/aggregate-status";
import { hasInstallFailure } from "@/lib/settings/install-failure";
import { useMcpHealth } from "@/lib/queries/mcp-health";

const CORE_IDS = new Set(["libi"]);

/** Bytes as a short human string, for the "freed N" toast. */
function formatBytes(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${Math.round(bytes / 1e6)} MB`;
  if (bytes >= 1e3) return `${Math.round(bytes / 1e3)} KB`;
  return `${bytes} B`;
}

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

function DependencyChips({ id, enabled }: { id: string; enabled: boolean }) {
  const { data: deps, isLoading } = useMcpServerDependencies(id, { enabled });
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

/**
 * The install state a row shows, rolled up from its live dependency
 * statuses. Trust `server.installStatus` for the terminal states the
 * dep-aggregate can't see (needs_config: env var missing; failed: the install
 * attempt errored); otherwise derive from the per-dep statuses so mid-flight
 * transitions (pending → installing → installed) move the badge in real time
 * without waiting on the row-level settle. Shared by the core card and every
 * nested extension row. `enabled: false` stops the poll while the tab is off
 * screen — the row is still mounted, the fetch is what has to stop.
 */
function useInstallState(server: McpServerUI, enabled: boolean) {
  const { data: deps } = useMcpServerDependencies(server.id, { enabled });
  const aggregateStatus =
    server.installStatus === "needs_config" || server.installStatus === "failed"
      ? server.installStatus
      : deps && deps.length > 0
        ? deriveAggregateStatus(deps)
        : server.installStatus;
  const failureDetected = server.bundled && hasInstallFailure(server, deps);
  const setupAction: "install" | "repair" | null = !server.bundled
    ? null
    : failureDetected || aggregateStatus === "failed"
      ? "repair"
      : aggregateStatus === "pending"
        ? "install"
        : null;
  return { deps, aggregateStatus, setupAction };
}

/**
 * "Server: up/down" + Retry + last error, for a row that spawns a server.
 * Hidden when the install isn't ready — a probe never ran, so "unknown" or a
 * stale "down" carries no information and the badge already says the row
 * needs config / install. Retry shows for every down server: the old
 * `!isTier2` gate dated from when tier-2 meant "libi tracks nothing".
 */
function ServerStatusLine({
  server,
  aggregateStatus,
}: {
  server: McpServerUI;
  aggregateStatus: string;
}) {
  const retryMutation = useRetryMcpServer();
  if (server.noServer) return null;
  if (aggregateStatus !== "installed" && aggregateStatus !== "not_required") return null;
  return (
    <>
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
        {server.serverStatus === "down" && (
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
      {server.serverError && (
        <details className="mt-1 text-xs text-muted-foreground">
          <summary className="cursor-pointer">Last error</summary>
          <pre className="mt-1 max-h-32 overflow-auto rounded bg-muted/40 p-2 text-[11px]">
            {server.serverError}
          </pre>
        </details>
      )}
    </>
  );
}

/**
 * One libi extension, nested inside the core card: install
 * badge, size, dependency chips with progress, server line when it has one,
 * and the approval switch. There is deliberately NO enable switch — an
 * extension's tools are always listed and its `enabled` column is ignored
 * (dropped by the migration); `requireApproval` is what the permission gate
 * enforces by tool prefix. Keeps its own `#mcp-<id>` anchor so
 * `libi.show_extension({ extensionId })` scrolls to the nested row.
 *
 * The approval switch is annotated when Codex is the active agent, because
 * there the gate is NOT IMPLEMENTED (`lib/approval/extensions.ts` LIMITATIONS
 * — buildable, since the nameless codex approval correlates by `toolCallId`,
 * but not built). QA watched a Codex session install 121 MB and synthesize
 * speech with `requireApproval` on and no prompt at all, narrating "the plan
 * asks for approval… I'm proceeding". Rendering the identical control for both
 * agents made it a claim the product could not keep; the annotation is the
 * smallest change that stops the claim, and it goes away on its own when the
 * gate ships.
 *
 * Annotated rather than disabled, and keyed on Codex specifically rather than
 * on "not Claude": the stored preference is per-extension, not per-agent, so it
 * is still the user's real setting for their next Claude session — disabling
 * the switch would block them from expressing it. `null` (no agent resolved
 * yet) and `terminal` (no agent at all, so no MCP tool calls to gate) say
 * nothing, and must not flash a warning.
 */
function ExtensionSettingsRow({ row, polling }: { row: McpServerUI; polling: boolean }) {
  const { activeProviderId } = useEditorState();
  const enforcedHere = activeProviderId !== "codex";
  const updateMcp = useUpdateMcpServer();
  const removeExtension = useRemoveExtension(row.id);
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const [setupDialogOpen, setSetupDialogOpen] = useState(false);
  const { deps, aggregateStatus, setupAction } = useInstallState(row, polling);
  const def = EXTENSION_MCP_SERVERS.find((d) => d.id === row.id);
  const sizeNote = PROVIDER_CATALOG.find((p) => p.extensionId === row.id)?.sizeNote;
  return (
    <>
      <div
        id={`mcp-${row.id}`}
        data-testid={`extension-row-${row.id}`}
        className="space-y-2 rounded-lg border border-border p-3"
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="truncate text-sm font-medium">{row.name}</span>
              <InstallStatusBadge
                status={aggregateStatus}
                error={row.installError}
                setupAction={setupAction}
                onSetupClick={setupAction ? () => setSetupDialogOpen(true) : undefined}
              />
            </div>
            <p className="text-[11px] leading-relaxed text-muted-foreground">
              {def?.description ?? row.description}
            </p>
            {sizeNote ? (
              <p className="text-[11px] text-muted-foreground">{sizeNote}</p>
            ) : null}
          </div>
          <label className="flex shrink-0 cursor-pointer items-center gap-2 text-[11px]">
            {enforcedHere ? null : (
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <span className="cursor-help rounded-full border border-yellow-600/40 bg-yellow-500/10 px-2 py-0.5 text-[10px] font-medium text-yellow-600" />
                    }
                  >
                    not enforced on Codex
                  </TooltipTrigger>
                  <TooltipContent className="max-w-xs text-xs">
                    libi enforces this gate for Claude Code only — on Codex it is not
                    implemented yet. With Codex active the switch asks the agent to
                    confirm in its plan; it cannot stop a tool call, and an agent can
                    decide it already has your go-ahead. Your choice is remembered and
                    takes effect on Claude Code.
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            )}
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger render={<span className="cursor-help" />}>
                  Require approval
                </TooltipTrigger>
                <TooltipContent className="max-w-xs text-xs">
                  The agent asks before calling this extension&rsquo;s tools. Turn it on when
                  they take meaningful time or download something.
                  {enforcedHere ? null : " libi enforces this for Claude Code only."}
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
            <Switch
              aria-label={`Require approval for ${row.name}`}
              className="cursor-pointer"
              size="sm"
              checked={row.requireApproval}
              onCheckedChange={(requireApproval) =>
                // `checked` is the server's value, so a failed PATCH leaves the
                // switch where it was — the toast is what says why.
                updateMcp.mutate(
                  { id: row.id, requireApproval },
                  {
                    onError: (err: unknown) => {
                      toast.error(
                        err instanceof Error
                          ? err.message
                          : `Couldn't update approval for ${row.name}.`,
                      );
                    },
                  },
                )
              }
            />
          </label>
        </div>
        <DependencyChips id={row.id} enabled={polling} />
        <ServerStatusLine server={row} aggregateStatus={aggregateStatus} />
        {/* Remove is offered ONLY once there is something to reclaim. On a
            never-installed extension it would be a button that deletes nothing,
            and on a shared-only extension (see lib/settings/removable-extensions.ts)
            it cannot be offered at all. */}
        {isRemovableExtension(row.id) && aggregateStatus === "installed" ? (
          <div className="flex justify-end">
            <Button
              size="sm"
              variant="ghost"
              className="cursor-pointer text-xs text-muted-foreground hover:text-destructive"
              disabled={removeExtension.isPending}
              onClick={() => setConfirmingRemove(true)}
            >
              Remove
            </Button>
          </div>
        ) : null}
      </div>
      {/* Deleting gigabytes off the user's disk is irreversible and takes a
          re-download to undo, so it confirms — the same shape and the same
          destructive styling as the connected-provider Remove. */}
      <AlertDialog open={confirmingRemove} onOpenChange={setConfirmingRemove}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {row.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              Deletes the files {row.name} downloaded to this machine
              {/* sizeNote is a full sentence of its own ("~121 MB model,
                  downloaded once, then free and offline."); its full stop
                  inside the parenthesis reads as a typo. */}
              {sizeNote ? ` (${sizeNote.replace(/\.$/, "")})` : ""}. libi will download them again the
              next time a tool needs them. Your pieces and settings are untouched.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="cursor-pointer">Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="cursor-pointer bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => {
                setConfirmingRemove(false);
                void removeExtension
                  .mutateAsync()
                  .then(({ freedBytes }) => {
                    toast.success(
                      freedBytes > 0
                        ? `Removed ${row.name} — freed ${formatBytes(freedBytes)}.`
                        : `Removed ${row.name}.`,
                    );
                  })
                  .catch((err: unknown) => {
                    toast.error(
                      err instanceof Error ? err.message : `Couldn't remove ${row.name}.`,
                    );
                  });
              }}
            >
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      {setupAction && (
        <McpSetupDialog
          open={setupDialogOpen}
          onOpenChange={setSetupDialogOpen}
          server={row}
          deps={deps}
          action={setupAction}
        />
      )}
    </>
  );
}

interface McpServerCardProps {
  server: McpServerUI;
  /** libi's extensions, rendered as rows nested inside this card. */
  extensions?: McpServerUI[];
  /**
   * False while the card is mounted but off screen (another tab, hidden
   * document): every dependency poll on the card and its rows stops.
   */
  polling?: boolean;
}

/**
 * libi's own card. Its one production caller (`McpServersView`) passes the
 * core row; the extensions are the rows nested inside it, so there is no
 * standalone non-core layout here any more.
 */
export function McpServerCard({ server, extensions, polling = true }: McpServerCardProps) {
  const isCore = CORE_IDS.has(server.id);
  // Only libi's own card shows the aggregator, so only it polls for it.
  const { data: mcpHealth } = useMcpHealth({ enabled: isCore });
  const aggregatorDown = mcpHealth ? !mcpHealth.ok : false;

  const [setupDialogOpen, setSetupDialogOpen] = useState(false);
  const { deps: depsForBadge, aggregateStatus, setupAction } = useInstallState(server, polling);

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
            {/* libi's own card carries the aggregator's health: every tool on
                this page — HTTP upstreams included — is served through that one
                endpoint, so when it is down "Installed" is true and useless.
                (The chip this replaced said "BYO-CLI only", which described a
                per-folder stdio setup that no longer exists.) */}
            {isCore && aggregatorDown ? (
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger render={<span className="inline-flex" />}>
                    <span className="inline-flex items-center gap-1 rounded-full border border-red-500/30 bg-red-500/10 px-2 py-0.5 text-[10px] font-medium text-red-400">
                      aggregator down
                    </span>
                  </TooltipTrigger>
                  <TooltipContent>
                    <p className="max-w-xs">
                      {mcpHealth?.error ??
                        "libi's MCP endpoint is not answering — agents have no tools until it comes back."}
                    </p>
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            ) : null}
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
          {/* Chips render for every bundled row. The old `!isTier2` gate was
              written when tier-2 meant "the agent installs this with its own
              Bash/uv/npm and libi tracks nothing" — true for the MCP packages,
              false for their BINARY deps, which have always gone through
              DependencyManager and always written install-token markers. Since
              2026-09-08 libi installs chromium and mediapipe-vision itself on
              tier-2 defs, so hiding their state was hiding libi's own work. */}
          {server.bundled && <DependencyChips id={server.id} enabled={polling} />}
          {extensions ? (
            <div className="mt-3 space-y-2 border-t border-border pt-3" data-testid="extension-rows">
              <h4 className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                Extensions
              </h4>
              <p className="text-[11px] text-muted-foreground">
                Optional pieces libi installs on your machine when a tool first needs them — or
                ahead of time from here. Free, on-device.
              </p>
              {extensions.map((row) => (
                <ExtensionSettingsRow key={row.id} row={row} polling={polling} />
              ))}
            </div>
          ) : null}
        </div>
        {/* The core row has no controls of its own — the approval
            switches live on the nested extension rows. */}
      </CardContent>
    </Card>
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
