"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { useEditorState } from "@/lib/editor-state-context";
import { mcpServerKeys } from "@/lib/queries/mcp-servers";
import { skillKeys } from "@/lib/queries/skills";

interface InstallFromUrlDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  defaultKind?: "mcp" | "skill";
}

type InstalledEntry = { kind: "skill" | "mcp"; name: string; note?: string };
type FailedEntry = { kind: "skill" | "mcp"; name: string; error: string };
type InstallResult = { installed: InstalledEntry[]; failed: FailedEntry[] };

type ManifestEntry = { name: string; relPath: string };

type Phase =
  | { stage: "idle" }
  | { stage: "fetching" }
  | { stage: "multi-skill-pick"; manifest: ManifestEntry[] }
  | { stage: "result"; kind: "claude-plugin" | "single-skill" | "multi-skill"; result: InstallResult }
  | { stage: "handed-off"; sessionId: string; reason?: string }
  | { stage: "error"; message: string; hint?: string; retryable: boolean };

export function InstallFromUrlDialog({
  open,
  onOpenChange,
  defaultKind,
}: InstallFromUrlDialogProps) {
  const router = useRouter();
  const pathname = usePathname();
  const queryClient = useQueryClient();
  const { sessionList } = useEditorState();

  const [url, setUrl] = useState("");
  const [phase, setPhase] = useState<Phase>({ stage: "idle" });
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const mountedRef = useRef(true);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      abortRef.current?.abort();
    };
  }, []);

  function handleOpenChange(next: boolean) {
    if (!next) {
      abortRef.current?.abort();
      setUrl("");
      setPhase({ stage: "idle" });
      setSelected(new Set());
    }
    onOpenChange(next);
  }

  const title =
    defaultKind === "skill"
      ? "Install skill from URL"
      : defaultKind === "mcp"
        ? "Install MCP from URL"
        : "Install from URL";

  async function postInstall(body: { url: string; selectedPaths?: string[] }) {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setPhase({ stage: "fetching" });

    let res: Response;
    try {
      res = await fetch("/api/install-from-url", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      if (controller.signal.aborted || !mountedRef.current) return;
      setPhase({
        stage: "error",
        message: "Couldn't reach GitHub",
        hint: (err as Error).message,
        retryable: true,
      });
      return;
    }

    if (!mountedRef.current || controller.signal.aborted) return;

    let data: Record<string, unknown>;
    try {
      data = await res.json();
    } catch {
      setPhase({
        stage: "error",
        message: "Invalid server response",
        retryable: true,
      });
      return;
    }

    if (!res.ok) {
      const message = typeof data.error === "string" ? data.error : `Request failed (${res.status})`;
      const hint = typeof data.hint === "string" ? data.hint : undefined;
      const retryable = res.status >= 500;
      setPhase({
        stage: "error",
        message,
        hint,
        retryable,
      });
      return;
    }

    const kind = data.kind as string;

    if (kind === "claude-plugin" || kind === "single-skill") {
      const result = data.result as InstallResult;
      invalidateAfterInstall(result);
      setPhase({ stage: "result", kind, result });
      return;
    }

    if (kind === "multi-skill") {
      if (data.result) {
        const result = data.result as InstallResult;
        invalidateAfterInstall(result);
        setPhase({ stage: "result", kind: "multi-skill", result });
        return;
      }
      const manifest = (data.manifest as ManifestEntry[]) ?? [];
      setPhase({ stage: "multi-skill-pick", manifest });
      setSelected(new Set(manifest.map((m) => m.relPath)));
      return;
    }

    if (kind === "handed-off") {
      setPhase({
        stage: "handed-off",
        sessionId: data.sessionId as string,
        reason: data.reason as string | undefined,
      });
      return;
    }

    setPhase({
      stage: "error",
      message: "Unrecognized server response",
      retryable: true,
    });
  }

  function invalidateAfterInstall(result: InstallResult) {
    const installedKinds = new Set(result.installed.map((i) => i.kind));
    if (installedKinds.has("skill")) {
      queryClient.invalidateQueries({ queryKey: skillKeys.all });
    }
    if (installedKinds.has("mcp")) {
      queryClient.invalidateQueries({ queryKey: mcpServerKeys.all });
    }
    if (installedKinds.size === 0) {
      queryClient.invalidateQueries({ queryKey: skillKeys.all });
      queryClient.invalidateQueries({ queryKey: mcpServerKeys.all });
    }
  }

  function handleInstall() {
    const trimmed = url.trim();
    if (!trimmed) return;
    void postInstall({ url: trimmed });
  }

  function handleConfirmMultiSkill() {
    if (phase.stage !== "multi-skill-pick") return;
    const paths = Array.from(selected);
    if (paths.length === 0) return;
    void postInstall({ url: url.trim(), selectedPaths: paths });
  }

  function toggleSelected(path: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  function handleOpenChat() {
    if (phase.stage !== "handed-off") return;
    const sid = phase.sessionId;
    handleOpenChange(false);
    if (pathname !== "/editor") {
      router.push("/editor");
    }
    sessionList.switchSession(sid);
  }

  function handleRetry() {
    handleInstall();
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>

        {(phase.stage === "idle" || phase.stage === "fetching" || phase.stage === "error") && (
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="install-url">GitHub URL</Label>
              <Input
                id="install-url"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://github.com/owner/repo"
                className="font-mono text-sm"
                autoFocus
                disabled={phase.stage === "fetching"}
              />
              <p className="text-xs text-muted-foreground">
                Paste a Claude plugin, a skill repo, or any GitHub repo. Sub-paths like{" "}
                <code className="font-mono">/tree/main/skills/foo</code> work too.
              </p>
            </div>

            {phase.stage === "error" && (
              <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm">
                <div className="font-medium text-destructive">{phase.message}</div>
                {phase.hint && (
                  <div className="mt-1 text-xs text-muted-foreground">{phase.hint}</div>
                )}
              </div>
            )}
          </div>
        )}

        {phase.stage === "multi-skill-pick" && (
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              This repo contains multiple skills. Pick which ones to install.
            </p>
            <div className="max-h-64 space-y-2 overflow-y-auto rounded-md border border-border p-2">
              {phase.manifest.map((m) => {
                const checked = selected.has(m.relPath);
                return (
                  <label
                    key={m.relPath}
                    className="flex cursor-pointer items-start gap-2 rounded-md px-2 py-1.5 hover:bg-accent/50"
                  >
                    <Checkbox
                      checked={checked}
                      onCheckedChange={() => toggleSelected(m.relPath)}
                      className="mt-0.5"
                    />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium">{m.name}</div>
                      <div className="truncate font-mono text-xs text-muted-foreground">
                        {m.relPath}
                      </div>
                    </div>
                  </label>
                );
              })}
            </div>
          </div>
        )}

        {phase.stage === "result" && (
          <div className="space-y-3">
            {phase.result.installed.length > 0 && (
              <div>
                <div className="mb-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Installed
                </div>
                <ul className="space-y-1">
                  {phase.result.installed.map((i, idx) => (
                    <li
                      key={`${i.kind}-${i.name}-${idx}`}
                      className="flex items-center gap-2 rounded-md border border-emerald-500/30 bg-emerald-500/5 px-2.5 py-1.5 text-sm"
                    >
                      <span className="rounded bg-emerald-500/20 px-1.5 py-0.5 text-[10px] font-medium uppercase text-emerald-600 dark:text-emerald-400">
                        {i.kind}
                      </span>
                      <span className="font-medium">{i.name}</span>
                      {i.note && (
                        <span className="text-xs text-muted-foreground">— {i.note}</span>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {phase.result.failed.length > 0 && (
              <div>
                <div className="mb-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Failed
                </div>
                <ul className="space-y-1">
                  {phase.result.failed.map((f, idx) => (
                    <li
                      key={`${f.kind}-${f.name}-${idx}`}
                      className="rounded-md border border-destructive/40 bg-destructive/5 px-2.5 py-1.5 text-sm"
                    >
                      <div className="flex items-center gap-2">
                        <span className="rounded bg-destructive/20 px-1.5 py-0.5 text-[10px] font-medium uppercase text-destructive">
                          {f.kind}
                        </span>
                        <span className="font-medium">{f.name}</span>
                      </div>
                      <div className="mt-0.5 text-xs text-muted-foreground">{f.error}</div>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {phase.result.installed.length === 0 && phase.result.failed.length === 0 && (
              <p className="text-sm text-muted-foreground">Nothing was installed.</p>
            )}
          </div>
        )}

        {phase.stage === "handed-off" && (
          <div className="space-y-3">
            <p className="text-sm">
              This URL doesn&apos;t look like a bundled Claude plugin or a skill — I opened a
              chat with your agent to figure it out.
            </p>
            {phase.reason && (
              <p className="text-xs text-muted-foreground">{phase.reason}</p>
            )}
          </div>
        )}

        <DialogFooter>
          {phase.stage === "idle" && (
            <>
              <Button
                variant="outline"
                className="cursor-pointer"
                onClick={() => handleOpenChange(false)}
              >
                Cancel
              </Button>
              <Button
                className="cursor-pointer"
                onClick={handleInstall}
                disabled={!url.trim()}
              >
                Install
              </Button>
            </>
          )}

          {phase.stage === "fetching" && (
            <>
              <Button variant="outline" className="cursor-pointer" disabled>
                Cancel
              </Button>
              <Button className="cursor-pointer" disabled>
                Installing…
              </Button>
            </>
          )}

          {phase.stage === "error" && (
            <>
              <Button
                variant="outline"
                className="cursor-pointer"
                onClick={() => handleOpenChange(false)}
              >
                Cancel
              </Button>
              {phase.retryable ? (
                <Button className="cursor-pointer" onClick={handleRetry}>
                  Retry
                </Button>
              ) : (
                <Button
                  className="cursor-pointer"
                  onClick={handleInstall}
                  disabled={!url.trim()}
                >
                  Try again
                </Button>
              )}
            </>
          )}

          {phase.stage === "multi-skill-pick" && (
            <>
              <Button
                variant="outline"
                className="cursor-pointer"
                onClick={() => handleOpenChange(false)}
              >
                Cancel
              </Button>
              <Button
                className="cursor-pointer"
                onClick={handleConfirmMultiSkill}
                disabled={selected.size === 0}
              >
                Install {selected.size} {selected.size === 1 ? "skill" : "skills"}
              </Button>
            </>
          )}

          {phase.stage === "result" && (
            <Button
              className="cursor-pointer"
              onClick={() => handleOpenChange(false)}
            >
              Close
            </Button>
          )}

          {phase.stage === "handed-off" && (
            <>
              <Button
                variant="outline"
                className="cursor-pointer"
                onClick={() => handleOpenChange(false)}
              >
                Close
              </Button>
              <Button className="cursor-pointer" onClick={handleOpenChat}>
                Open chat
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
