"use client";

import { useEffect, useMemo, useState } from "react";
import { DownloadIcon, RefreshCwIcon, RotateCcwIcon } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  isInstallInFlight,
  isShellInstallInFlight,
  restartOffer,
  updateOffer,
  useInstallRuntimeUpdate,
  useRecheckRuntimeUpdate,
  useRestartToApply,
  useRuntimeUpdate,
  type RuntimeUpdateDto,
} from "@/lib/queries/runtime-update";

/**
 * Settings → General → "Version & updates".
 *
 * Covers BOTH update channels. Since the auto-download change the normal
 * lifecycle needs no clicks until the end: found → downloading in the
 * background (copy, no button) → ready ("Restart to apply"). The legacy
 * "Install & restart" button survives only where a click still starts a
 * download: a runtime auto-download that failed ("Try again"), or a shell
 * update surfaced by an OLD desktop shell that can't auto-download.
 *
 * ## The three honesty rules this component is built around
 *
 * 1. **A failed check is invisible.** The server answers `state: "unknown"`
 *    (or a shell `phase: "error"`) when it could not reach its feed; that
 *    renders as nothing but the version lines and a "Check again" button.
 *    Offline is the normal state for some users, not an error — and an error
 *    toast on a plane is a support ticket about a non-problem.
 *
 * 2. **Never offer an install that cannot work.** A newer runtime outside this
 *    desktop app's `shellApiVersion` range would download, land on disk, and be
 *    rejected by the loader at next launch. When the NEW SHELL that fixes that
 *    is already on the releases feed, the shell channel covers it (that update
 *    IS the remedy); only when it isn't does the plain "update the desktop
 *    app" line render, with NO install button.
 *
 * 3. **Never imply a live upgrade.** A runtime install writes a sibling
 *    directory and leaves the running runtime untouched; restarting is what
 *    applies it, and the restart is ALWAYS an explicit click — the download
 *    happened without one, so the app never yanks itself out from under the
 *    user on a timer. (Old shells are the one exception: their downloads
 *    only start from a click, and that click consented to the self-restart.)
 */

function sourceLabel(source: string): string {
  if (source === "user") return "installed by in-app update";
  if (source === "bundled") return "bundled with the desktop app";
  return "development checkout";
}

function VersionLine({ dto }: { dto: RuntimeUpdateDto }) {
  // Two labeled rows, so "which of these is the app I dragged to
  // /Applications?" never needs a support answer. The runtime is what the
  // user experiences; the desktop shell re-ships rarely and is expected to
  // trail it.
  return (
    <div className="space-y-0.5">
      <div className="flex items-baseline gap-2">
        <span className="w-24 text-xs text-muted-foreground">Runtime</span>
        <span className="font-mono text-sm text-foreground">
          {dto.current.version ?? "unknown version"}
        </span>
        <span className="text-xs text-muted-foreground">
          {sourceLabel(dto.current.source)}
        </span>
      </div>
      {dto.shell && (
        <div className="flex items-baseline gap-2">
          <span className="w-24 text-xs text-muted-foreground">Desktop app</span>
          <span className="font-mono text-sm text-foreground">
            {dto.shell.currentVersion}
          </span>
        </div>
      )}
    </div>
  );
}

export function UpdatesSection() {
  const { data, isLoading, isError } = useRuntimeUpdate();
  const recheck = useRecheckRuntimeUpdate();
  const install = useInstallRuntimeUpdate();
  const restart = useRestartToApply();

  // Arriving from the update toast (`/settings?highlight=version`) flashes
  // this section for a beat, so the toast click visibly LANDS somewhere
  // instead of just dismissing. `location.search` is read in an effect
  // rather than through useSearchParams — no Suspense boundary needed — and
  // the param is stripped immediately so a reload doesn't re-flash.
  // Lazy initializer, not an effect: reading the param during the first
  // render avoids the setState-in-effect cascading-render hazard the hooks
  // lint rejects. The effect only strips the param and schedules the fade.
  const [flash, setFlash] = useState(() => {
    if (typeof window === "undefined") return false;
    return new URLSearchParams(window.location.search).get("highlight") === "version";
  });
  useEffect(() => {
    if (!flash) return;
    window.history.replaceState(null, "", window.location.pathname);
    const timer = setTimeout(() => setFlash(false), 2200);
    return () => clearTimeout(timer);
  }, [flash]);

  // The two offers, memoized on `data` because the helpers return fresh
  // objects per call while React Query's structural sharing keeps `data`
  // stable between identical polls.
  const ready = useMemo(() => restartOffer(data), [data]);
  const offer = useMemo(() => updateOffer(data), [data]);

  if (isLoading) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-5 w-40" />
        <Skeleton className="h-4 w-64" />
        <Skeleton className="h-9 w-32" />
      </div>
    );
  }

  // The route itself never fails on a network problem, so a rejected query
  // means the local server is unreachable — there is nothing useful to say
  // and nothing actionable to offer.
  if (isError || !data) return null;

  const installing = isInstallInFlight(data);
  const shellInstalling = isShellInstallInFlight(data);
  const anyInstalling = installing || shellInstalling;
  const failed = data.install?.status === "failed";
  // A shell download that died reverts to the offer with `error` set — the
  // button comes back, and this line says why it's back.
  const shellFailed = offer?.target === "shell" && data.shell?.error != null;
  const state = data.update.state;
  const restartRequested = !restart.isIdle;

  return (
    <div
      data-highlight={flash || undefined}
      className={
        "space-y-3 rounded-lg transition-all duration-700 " +
        (flash ? "bg-primary/10 ring-2 ring-primary/50 p-3 -m-3" : "ring-0 ring-transparent")
      }
    >
      <div className="flex items-center gap-2">
        <h3 className="text-sm font-semibold text-foreground">Version</h3>
        {ready && !restartRequested && <Badge variant="default">Update ready</Badge>}
        {!ready && offer && !anyInstalling && (
          <Badge variant="default">Update available</Badge>
        )}
      </div>

      <VersionLine dto={data} />

      {/* ── Downloaded, waiting for the restart ───────────────────────── */}
      {ready &&
        (restartRequested ? (
          <p className="text-sm text-foreground">
            Libi <span className="font-mono">{ready.version}</span> is
            installed. <span className="text-muted-foreground">Restarting Libi…</span>
          </p>
        ) : (
          <p className="text-sm text-foreground">
            Libi <span className="font-mono">{ready.version}</span> downloaded
            in the background.{" "}
            <span className="text-muted-foreground">
              Restart whenever suits you — Libi keeps working until then.
            </span>
          </p>
        ))}

      {/* ── In flight (started automatically) ─────────────────────────── */}
      {installing && !ready && (
        <p className="text-sm text-muted-foreground">
          Downloading Libi{" "}
          <span className="font-mono">{data.install?.version ?? ""}</span> in
          the background… Libi keeps working while it runs, and you choose
          when to restart.
        </p>
      )}
      {data.shell?.phase === "downloading" && (
        <p className="text-sm text-muted-foreground">
          Downloading the new Libi
          {data.shell.percent !== null ? ` — ${data.shell.percent}%` : "…"}
          {data.shell.autoDownload
            ? " Libi keeps working while it runs."
            : " Libi restarts by itself when it's ready."}
        </p>
      )}
      {/* An OLD shell's ready state self-restarts moments later. */}
      {data.shell?.phase === "ready" && !data.shell.autoDownload && (
        <p className="text-sm text-foreground">
          Libi <span className="font-mono">{data.shell.latestVersion}</span> is
          installed. <span className="text-muted-foreground">Restarting Libi…</span>
        </p>
      )}

      {/* ── Failed, honestly ──────────────────────────────────────────── */}
      {failed && !anyInstalling && !ready && (
        <p className="text-sm text-destructive">
          The update didn&apos;t download, so Libi is still running{" "}
          <span className="font-mono">{data.current.version}</span>.{" "}
          {data.install?.error ?? "No further detail was recorded."}
        </p>
      )}
      {shellFailed && !anyInstalling && (
        <p className="text-sm text-destructive">
          The update didn&apos;t install, so Libi is still running{" "}
          <span className="font-mono">{data.shell?.currentVersion}</span>.{" "}
          {data.shell?.error}
        </p>
      )}

      {/* ── The check outcomes ────────────────────────────────────────── */}
      {!anyInstalling && !ready && !offer && !failed && state === "up-to-date" && (
        <p className="text-sm text-muted-foreground">Libi is up to date.</p>
      )}

      {/* Only when the shell that would fix it is NOT on the feed yet —
          once it is, the shell channel IS this state's remedy. */}
      {!anyInstalling && !ready && !offer && state === "shell-update-required" && (
        <p className="text-sm text-muted-foreground">
          Libi <span className="font-mono">{data.update.latestVersion}</span> is
          available, but it needs a newer version of the desktop app — this one
          can&apos;t run it. Download the latest Libi release to update.
        </p>
      )}

      {state === "unsupported" && (
        <p className="text-sm text-muted-foreground">
          Updates are managed outside the app here — this Libi runs from a
          checkout or an npm install.
        </p>
      )}

      {/* `unknown` deliberately renders NO explanation: see rule 1 above. */}

      <div className="flex items-center gap-2">
        {ready && (
          <Button
            className="cursor-pointer"
            disabled={restartRequested}
            onClick={() => restart.mutate(ready)}
          >
            <RotateCcwIcon className="size-4" />
            {restartRequested ? "Restarting…" : "Restart to apply"}
          </Button>
        )}
        {!ready && offer && (
          <Button
            className="cursor-pointer"
            disabled={anyInstalling || install.isPending}
            onClick={() => install.mutate(offer)}
          >
            <DownloadIcon className="size-4" />
            {anyInstalling || install.isPending
              ? "Installing…"
              : failed || shellFailed
                ? `Try again (${offer.version})`
                : `Install ${offer.version} & restart`}
          </Button>
        )}
        {state !== "unsupported" && (
          <Button
            variant="outline"
            className="cursor-pointer"
            disabled={recheck.isPending || anyInstalling}
            onClick={() => recheck.mutate()}
          >
            <RefreshCwIcon className="size-4" />
            {recheck.isPending ? "Checking…" : "Check again"}
          </Button>
        )}
      </div>

      {install.isError && (
        <p className="text-sm text-destructive">
          {(install.error as Error).message}
        </p>
      )}
      {restart.isError && (
        <p className="text-sm text-destructive">
          {(restart.error as Error).message}
        </p>
      )}
    </div>
  );
}
