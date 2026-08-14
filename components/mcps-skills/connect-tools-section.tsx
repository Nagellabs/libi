"use client";

import { Terminal, Loader2, FileText } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
  TooltipProvider,
} from "@/components/ui/tooltip";
import {
  useCodexConnect,
  useSetCodexConnect,
  type CodexCliSource,
} from "@/lib/queries/codex-connect";
import { useCreateTerminal } from "@/lib/queries/terminals";
import { useRunRemedyInTerminal } from "@/hooks/agents/use-run-remedy-in-terminal";
import { revealFile } from "@/lib/shell/client";
import { trackEvent } from "@/lib/analytics/client";
import { toast } from "sonner";

/** See the same constant in components/layout/app-sidebar.tsx — the terminal's
 *  insert listener only exists once React has committed the xterm subtree. */

/**
 * "Use libi in your own tools" — brings libi's MCP tools into CLI agents the
 * user runs themselves. The Codex row Installs/Uninstalls libi's servers into
 * the codex config (via codex's own `mcp add`/`remove`); status is read LIVE on
 * every mount (`GET /api/codex/connect` probes `codex mcp list`), so the chip
 * reflects codex's actual state, not a stored flag. The Claude Code row is
 * informational — Claude Code uses `npx @nagellabs/libi --connect-agent`.
 *
 * The Codex row has THREE distinguishable states, not one grey "Not installed"
 * chip. That single chip conflated "you have no codex" with "you have one and
 * libi isn't registered in it", and — worse — the underlying probe could report
 * available for libi's OWN bundled codex shim, so Install was offered, ran
 * successfully, and wrote MCP config into a binary the user cannot invoke.
 * Install is now offered ONLY for `cliSource === "user"`.
 */
export function ConnectToolsSection() {
  const { data, isLoading } = useCodexConnect();
  const setConnect = useSetCodexConnect();
  const createTerminal = useCreateTerminal();
  const runRemedyInTerminal = useRunRemedyInTerminal();

  const installed = data?.installed ?? false;
  const status = data?.status ?? "idle";
  const configPath = data?.configPath;
  const configExists = data?.configExists ?? false;
  const codexHome = data?.codexHome;
  // Fall back to the pre-cliSource response shape rather than claiming "none".
  const cliSource: CodexCliSource =
    data?.cliSource ?? ((data?.available ?? false) ? "user" : "none");
  const isUserCli = cliSource === "user";
  const remedy = data?.remedy ?? null;

  const busy = isLoading || setConnect.isPending;
  const refusal = setConnect.error;

  // "Open config" reveals the codex config.toml in the OS file manager (or the
  // codex home folder if it doesn't exist yet) so the user can see exactly what
  // is — or isn't — configured and fix issues by hand.
  const revealTarget = configExists ? configPath : codexHome;

  const chip = (() => {
    if (installed && status === "error") {
      return { label: "Sync error", cls: "bg-destructive/15 text-destructive" };
    }
    if (installed) {
      return { label: "Registered", cls: "bg-emerald-500/15 text-emerald-500" };
    }
    if (isUserCli) {
      return {
        label: "Not registered",
        cls: "bg-amber-400/15 text-amber-500",
      };
    }
    // `libi-internal` and `none` read the same to a user: they have no codex of
    // their own. The distinction matters to the PROBE (it is why we refuse to
    // write config) but not to the person, so it gets one chip, not two.
    return { label: "Codex not installed", cls: "bg-muted text-muted-foreground" };
  })();

  /**
   * One short line. Anything longer does not get read — and the states this
   * used to spell out at length (notably "an earlier build of libi registered
   * tools against its own bundled codex") no longer happen: libi refuses to
   * write config unless it finds a codex of the user's own.
   */
  const explanation = (() => {
    if (!isUserCli) {
      return "Install the Codex CLI to use libi's tools in your own terminal.";
    }
    if (installed) {
      return "Your Codex picks up libi's tools.";
    }
    return "Adds libi's tools to your Codex config.";
  })();

  const handleClick = (next: boolean) => {
    setConnect.mutate(next, {
      onSuccess: () => {
        trackEvent("codex_connect_toggled", { connected: next });
      },
    });
  };

  return (
    <section className="space-y-3">
      <div>
        <h2 className="text-sm font-semibold text-foreground">
          Use libi in your own tools
        </h2>
        <p className="mt-0.5 text-xs text-muted-foreground">
          Bring libi&apos;s tools into the CLI agents you run yourself.
        </p>
      </div>

      <div className="divide-y divide-border rounded-lg border border-border">
        {/* Codex row — Install / Uninstall into the codex config */}
        <div className="flex items-center gap-3 px-4 py-3">
          <Terminal className="size-4 flex-shrink-0 text-muted-foreground" />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium text-foreground">Codex</span>
              <span
                className={`rounded-full px-1.5 py-0.5 text-[10px] font-medium ${chip.cls}`}
              >
                {chip.label}
              </span>
            </div>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {explanation}
            </p>
            {!isUserCli && remedy ? (
              <p className="mt-1 text-xs text-muted-foreground">
                {remedy.detail}{" "}
                <code className="rounded bg-muted px-1 py-0.5 font-mono text-[11px]">
                  {remedy.command}
                </code>
              </p>
            ) : null}
            {/* A refusal is the ONLY honest outcome when there is no codex to
                run `mcp remove` with. The server hands back the file path and
                the exact table names, so render them — a toast that scrolls
                away is not an instruction you can follow. */}
            {refusal ? (
              <p className="mt-1 text-xs text-destructive">
                {refusal.message}
              </p>
            ) : null}
          </div>

          <div className="flex flex-shrink-0 items-center gap-2">
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      variant="ghost"
                      size="sm"
                      className="cursor-pointer text-muted-foreground"
                      disabled={!revealTarget}
                      onClick={() => revealTarget && void revealFile(revealTarget)}
                    >
                      <FileText className="mr-1.5 size-3.5" />
                      Open config
                    </Button>
                  }
                />
                <TooltipContent className="max-w-[280px] font-mono text-[11px]">
                  {configExists
                    ? configPath
                    : `${codexHome ?? "codex home"} (no config.toml yet)`}
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>

            {isUserCli ? (
              // The ONLY state where writing MCP config into codex reaches the
              // user's own tools.
              <Button
                variant={installed ? "outline" : "default"}
                size="sm"
                className="cursor-pointer"
                disabled={busy}
                onClick={() => handleClick(!installed)}
              >
                {busy && <Loader2 className="mr-1.5 size-3.5 animate-spin" />}
                {installed ? "Uninstall" : "Install"}
              </Button>
            ) : remedy ? (
              <Button
                variant="default"
                size="sm"
                className="cursor-pointer"
                disabled={createTerminal.isPending}
                onClick={() => void runRemedyInTerminal(remedy)}
              >
                {createTerminal.isPending && (
                  <Loader2 className="mr-1.5 size-3.5 animate-spin" />
                )}
                {remedy.label}
              </Button>
            ) : null}
          </div>
        </div>

        {/* Claude Code row — informational only */}
        <div className="flex items-start gap-3 px-4 py-3">
          <Terminal className="mt-0.5 size-4 flex-shrink-0 text-muted-foreground" />
          <div className="min-w-0 flex-1">
            <span className="text-sm font-medium text-foreground">
              Claude Code
            </span>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Run{" "}
              <code className="rounded bg-muted px-1 py-0.5 font-mono text-[11px]">
                npx @nagellabs/libi
              </code>{" "}
              — libi wires its tools into the default agent folder (
              <code className="rounded bg-muted px-1 py-0.5 font-mono text-[11px]">
                ~/.libi/agent
              </code>
              ), so a Claude Code run there has them automatically.
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              Connect a specific folder instead:{" "}
              <code className="rounded bg-muted px-1 py-0.5 font-mono text-[11px]">
                npx @nagellabs/libi --connect-agent &lt;dir&gt;
              </code>
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}
