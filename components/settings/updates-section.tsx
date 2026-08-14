"use client";

import { useEffect, useMemo, useState } from "react";
import { DownloadIcon, RefreshCwIcon } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  isInstallInFlight,
  isShellInstallInFlight,
  updateOffer,
  useInstallRuntimeUpdate,
  useRecheckRuntimeUpdate,
  useRuntimeUpdate,
  type RuntimeUpdateDto,
} from "@/lib/queries/runtime-update";
import { useResetServer } from "@/lib/queries/server-status";

/**
 * Settings → General → "Version & updates".
 *
 * Covers BOTH update channels through the one `updateOffer()` the toast also
 * uses: the npm runtime (weekly cadence, installed in place by a job) and
 * the desktop shell itself (rare cadence, electron-updater downloads it and
 * the shell restarts itself). The user sees a single "Install X & restart"
 * either way.
 *
 * ## The three honesty rules this component is built around
 *
 * 1. **A failed check is invisible.** The server answers `state: "unknown"`
 *    (or a shell `phase: "error"`) when it could not reach its feed; that
 *    renders as nothing but the version line and a "Check again" button.
 *    Offline is the normal state for some users, not an error — and an error
 *    toast on a plane is a support ticket about a non-problem.
 *
 * 2. **Never offer an install that cannot work.** A newer runtime outside this
 *    desktop app's `shellApiVersion` range would download, land on disk, and be
 *    rejected by the loader at next launch. When the NEW SHELL that fixes that
 *    is already on the releases feed, the shell offer covers it (that update
 *    IS the remedy); only when it isn't does the plain "update the desktop
 *    app" line render, with NO install button.
 *
 * 3. **Never imply a live upgrade.** A runtime install writes a sibling
 *    directory and leaves the running runtime untouched; the shell picks it up
 *    at next launch. The button therefore says "Install & restart", and when
 *    an install STARTED FROM THIS SESSION completes we trigger that restart
 *    automatically (the same `/api/server-status/reset` the MCPs & Skills
 *    "Restart server" button uses — `app.relaunch()` in the packaged shell).
 *    A shell install restarts itself from the main process once the download
 *    is verified — the Install click is the consent in both cases.
 *
 *    A `pendingVersion` that was already there when this page mounted gets the
 *    passive "Restart Libi to finish updating" copy instead: the user chose to
 *    keep working past that install (maybe days ago) — yanking the app out
 *    from under them at some arbitrary later mount is not what they asked for.
 *    The consent to restart is the Install click, and it does not outlive the
 *    session that clicked it. (No shell equivalent exists: shell downloads
 *    only start from a click and restart moments later.)
 */

function sourceLabel(source: string): string {
  if (source === "user") return "downloaded";
  if (source === "bundled") return "bundled with the app";
  return "development checkout";
}

function VersionLine({ dto }: { dto: RuntimeUpdateDto }) {
  return (
    <div className="space-y-0.5">
      <div className="flex items-baseline gap-2">
        <span className="font-mono text-sm text-foreground">
          {dto.current.version ?? "unknown version"}
        </span>
        <span className="text-xs text-muted-foreground">
          {sourceLabel(dto.current.source)}
        </span>
      </div>
      {/* The two halves can genuinely differ (the shell re-ships rarely),
          and "which desktop app am I on?" is the first support question. */}
      {dto.shell && dto.shell.currentVersion !== dto.current.version && (
        <div className="flex items-baseline gap-2">
          <span className="font-mono text-sm text-foreground">
            {dto.shell.currentVersion}
          </span>
          <span className="text-xs text-muted-foreground">desktop app</span>
        </div>
      )}
    </div>
  );
}

export function UpdatesSection() {
  const { data, isLoading, isError } = useRuntimeUpdate();
  const recheck = useRecheckRuntimeUpdate();
  const install = useInstallRuntimeUpdate();
  const reset = useResetServer();

  // True once the user clicks Install in THIS session — the consent that
  // authorises the automatic restart below. State, not a ref: it drives the
  // "restarts when ready" copy, which a ref mutation would never re-render
  // for (and react-hooks/refs rejects ref reads during render outright).
  const [installedThisSession, setInstalledThisSession] = useState(false);

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

  // Fire the restart when the install this session started completes
  // (pendingVersion appears). The mutation's OWN idle state is the
  // fired-already guard — poll ticks keep delivering the same
  // pendingVersion, but after mutate() the mutation is no longer idle. No
  // parallel useState: setState inside an effect is a cascading-render
  // hazard the react-hooks rules reject, and the mutation state already
  // re-renders for the "Restarting Libi…" copy.
  const pendingVersion = data?.pendingVersion ?? null;
  const restartRequested = !reset.isIdle;
  useEffect(() => {
    if (!pendingVersion || !installedThisSession || !reset.isIdle) return;
    reset.mutate();
  }, [pendingVersion, installedThisSession, reset]);

  // The single offer, either channel — memoized on `data` because
  // updateOffer returns a fresh object per call while React Query's
  // structural sharing keeps `data` stable between identical polls.
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
        {offer && !data.pendingVersion && !anyInstalling && (
          <Badge variant="default">Update available</Badge>
        )}
      </div>

      <VersionLine dto={data} />

      {/* ── Already downloaded ────────────────────────────────────────── */}
      {data.pendingVersion &&
        (restartRequested ? (
          <p className="text-sm text-foreground">
            Libi <span className="font-mono">{data.pendingVersion}</span> is
            installed.{" "}
            <span className="text-muted-foreground">Restarting Libi…</span>
          </p>
        ) : (
          <p className="text-sm text-foreground">
            Libi{" "}
            <span className="font-mono">{data.pendingVersion}</span> is
            downloaded.{" "}
            <span className="text-muted-foreground">
              Restart Libi to finish updating.
            </span>
          </p>
        ))}

      {/* ── In flight ─────────────────────────────────────────────────── */}
      {installing && !data.pendingVersion && (
        <p className="text-sm text-muted-foreground">
          Downloading Libi{" "}
          <span className="font-mono">{data.install?.version ?? ""}</span>… This
          can take a few minutes, and Libi keeps working while it runs.
          {installedThisSession && " Libi restarts when it's ready."}
        </p>
      )}

      {/* The shell channel restarts itself once verified, so "ready" is the
          last state a poll can see — render it as the restart it is. */}
      {data.shell?.phase === "downloading" && (
        <p className="text-sm text-muted-foreground">
          Downloading the new Libi
          {data.shell.percent !== null ? ` — ${data.shell.percent}%` : "…"} Libi
          restarts by itself when it&apos;s ready.
        </p>
      )}
      {data.shell?.phase === "ready" && (
        <p className="text-sm text-foreground">
          Libi <span className="font-mono">{data.shell.latestVersion}</span> is
          installed. <span className="text-muted-foreground">Restarting Libi…</span>
        </p>
      )}

      {/* ── Failed, honestly ──────────────────────────────────────────── */}
      {failed && !anyInstalling && !data.pendingVersion && (
        <p className="text-sm text-destructive">
          The update didn&apos;t install, so Libi is still running{" "}
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
      {!anyInstalling && !data.pendingVersion && !offer && state === "up-to-date" && (
        <p className="text-sm text-muted-foreground">Libi is up to date.</p>
      )}

      {/* Only when the shell that would fix it is NOT on the feed yet —
          once it is, the offer button above IS this state's remedy. */}
      {!anyInstalling && !data.pendingVersion && !offer && state === "shell-update-required" && (
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
        {offer && !data.pendingVersion && (
          <Button
            className="cursor-pointer"
            disabled={anyInstalling || install.isPending}
            onClick={() => {
              setInstalledThisSession(true);
              install.mutate(offer);
            }}
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
    </div>
  );
}
