"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  DownloadIcon,
  ExternalLinkIcon,
  RefreshCwIcon,
  RotateCcwIcon,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { compareVersions } from "@/lib/runtime/version-compare";
import {
  blockedShellUpdate,
  isInstallInFlight,
  isShellAutoDownloadWindow,
  isShellSelfRestarting,
  isShellInstallInFlight,
  restartOffer,
  SHELL_CHECK_STALE_MS,
  updateOffer,
  type BlockedShellUpdate,
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
 * 2b. **…and never stay silent about an install that cannot work.** The one
 *    exception to rule 1's "failures are invisible": when the app is running
 *    from somewhere it cannot replace its own bundle, the update is not
 *    merely unavailable — it is unavailable in a way only the user can fix,
 *    and forever if they never find out. That card is NOT dismissible.
 *
 * 3. **Never imply a live upgrade.** A runtime install writes a sibling
 *    directory and leaves the running runtime untouched; restarting is what
 *    applies it, and the restart is ALWAYS an explicit click — the download
 *    happened without one, so the app never yanks itself out from under the
 *    user on a timer. (Old shells are the one exception: their downloads
 *    only start from a click, and that click consented to the self-restart.)
 */

/** Where a user goes when the in-app path can't work. Always works. */
export const RELEASES_URL = "https://github.com/Nagellabs/libi/releases/latest";

/**
 * What to tell a user whose app can't replace its own bundle.
 *
 * Name the cause first, then give the fix as steps they can follow without
 * knowing what "translocation" means. The path is rendered separately and
 * verbatim — it is the evidence, and the thing that makes any of this
 * checkable from their side.
 */
function blockedCopy(blocked: BlockedShellUpdate): { body: string; steps: string[] } {
  switch (blocked.reason) {
    case "translocated":
      return {
        body:
          "macOS is running Libi from a temporary read-only copy. That happens " +
          "when the app hasn't been moved into Applications properly — Libi " +
          `${blocked.version} is ready, but it can't be installed here.`,
        steps: [
          "Quit Libi.",
          "Open the Libi disk image and drag Libi into Applications, replacing the old copy.",
          "Open Libi from Applications.",
        ],
      };
    case "running-from-dmg":
      return {
        body:
          "Libi is running straight from its disk image, which can't be written " +
          `to. Libi ${blocked.version} is ready, but it can't be installed there.`,
        steps: [
          "Quit Libi.",
          "Drag Libi from the disk image into Applications.",
          "Open Libi from Applications, then eject the disk image.",
        ],
      };
    case "not-in-applications":
      return {
        body:
          "Libi is running from a folder it isn't allowed to write to, so it " +
          `can't replace itself with Libi ${blocked.version}.`,
        steps: [
          "Quit Libi.",
          "Move Libi into your Applications folder.",
          "Open Libi from Applications.",
        ],
      };
    case "read-only-location":
    default:
      return {
        body:
          "Libi can't write to the folder it's running from, so it can't " +
          `replace itself with Libi ${blocked.version}. On a managed Mac or PC ` +
          "an administrator may need to do this for you.",
        steps: [
          "Quit Libi.",
          "Move Libi somewhere you can write to — Applications is the usual place.",
          "Open Libi again from there.",
        ],
      };
  }
}

/**
 * The blocked card. No dismiss, by design: the condition outlives any
 * session, and the previous behaviour — a log line and a "Try again" button
 * that re-downloaded 481 MB to fail identically — is what happens when this
 * is left implicit.
 */
function BlockedCard({ blocked }: { blocked: BlockedShellUpdate }) {
  const { body, steps } = blockedCopy(blocked);
  return (
    <div className="space-y-2 rounded-md border border-destructive/40 bg-destructive/5 p-3">
      <p className="text-sm font-medium text-foreground">
        Libi can&apos;t update itself from where it&apos;s running
      </p>
      <p className="text-sm text-muted-foreground">{body}</p>
      <ol className="list-decimal space-y-0.5 pl-5 text-sm text-muted-foreground">
        {steps.map((step) => (
          <li key={step}>{step}</li>
        ))}
      </ol>
      {blocked.path && (
        <p className="break-all font-mono text-xs text-muted-foreground">
          Running from: {blocked.path}
        </p>
      )}
    </div>
  );
}

function sourceLabel(source: string): string {
  if (source === "user") return "installed by in-app update";
  if (source === "bundled") return "bundled with the desktop app";
  // Was "development checkout" for this case too, which is what an
  // `npx @nagellabs/libi` user — the README's primary install path — saw.
  if (source === "npm") return "installed from npm";
  return "development checkout";
}

/** The version that will be running after a restart, and why it is not running yet.
 *  Null when what is running IS the newest thing on disk.
 *
 *  A staged runtime and a running download can both exist at once — 0.1.13 landed and
 *  is waiting for a restart while 0.1.14 is already being fetched. Showing only the
 *  staged one made the newer download invisible, so when both exist this shows
 *  whichever version is actually NEWER (there is only ever one row here either way). */
export function pendingRuntimeLine(
  dto: RuntimeUpdateDto,
): { version: string; state: "downloading" | "ready" } | null {
  const staged = dto.pendingVersion
    ? { version: dto.pendingVersion, state: "ready" as const }
    : null;
  const downloading =
    isInstallInFlight(dto) && dto.install?.version
      ? { version: dto.install.version, state: "downloading" as const }
      : null;
  if (staged && downloading) {
    return compareVersions(downloading.version, staged.version) > 0 ? downloading : staged;
  }
  return staged ?? downloading;
}

function VersionLine({ dto }: { dto: RuntimeUpdateDto }) {
  // Three labeled rows, so "which of these is the app I dragged to
  // /Applications?" — and "which one is actually running right now?" — never
  // need a support answer. The runtime is what the user experiences; the
  // desktop shell re-ships rarely and is expected to trail it; "Next launch"
  // only appears once there is something that isn't running yet.
  const pending = pendingRuntimeLine(dto);
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
      {pending && (
        <div className="flex items-baseline gap-2">
          <span className="w-24 text-xs text-muted-foreground">Next launch</span>
          <span className="font-mono text-sm text-foreground">{pending.version}</span>
          <span className="text-xs text-muted-foreground">
            {pending.state === "ready" ? "downloaded — applies at next launch" : "downloading…"}
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
  const blocked = useMemo(() => blockedShellUpdate(data), [data]);

  // Mount re-check: a card that opened on a snapshot taken before the shell's
  // last feed check (or one that never happened) has no other way to learn
  // about it — the poll interval only speeds up once something is ALREADY
  // moving. `useRecheckRuntimeUpdate()` returns a new mutation object every
  // render, so `recheck` is NOT what keeps this to one shot — the effect
  // below re-runs on every render regardless. The `askedForCheck` ref is what
  // makes it one forced GET per mount: it is set to true BEFORE `mutate()` is
  // called, so a forced check that FAILS is not retried for the life of the
  // mount. That is deliberate, not a gap to close with retry machinery — the
  // user's "Check again" button is the retry, and a background retry loop
  // against an unreachable feed is exactly what rule 1 above ("a failed check
  // is invisible") exists to avoid. Also never fires when this install has no
  // shell channel at all (a dev tree / npx install).
  const askedForCheck = useRef(false);
  useEffect(() => {
    if (askedForCheck.current || !data?.shell) return;
    const checkedAt = data.shell.checkedAt;
    if (checkedAt !== null && Date.now() - checkedAt < SHELL_CHECK_STALE_MS) return;
    askedForCheck.current = true;
    recheck.mutate();
  }, [data?.shell, recheck]);

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
  // An old shell at `ready` is quitting into its update on its own. It counts as
  // in-flight, but "Downloading" is the wrong word for a download that finished.
  const shellSelfRestarting = isShellSelfRestarting(data.shell);

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
        {/* Mutually exclusive: something in flight outranks a stationary offer, which
            outranks nothing at all. An OLD shell's self-restarting "ready" plus a
            staged runtime used to show BOTH "Update ready" and "Downloading" at once
            while the body only ever said "Restarting Libi…" — one badge per state. */}
        {shellSelfRestarting ? (
          <Badge variant="secondary">Restarting</Badge>
        ) : anyInstalling ? (
          <Badge variant="secondary">Downloading</Badge>
        ) : ready && !restartRequested ? (
          <Badge variant="default">Update ready</Badge>
        ) : offer ? (
          <Badge variant="default">Update available</Badge>
        ) : null}
        {blocked && <Badge variant="destructive">Can&apos;t update</Badge>}
      </div>

      <VersionLine dto={data} />

      {/* `restartOffer` is suppressed for this whole window — an auto-download
          shell fetching its update, or about to (it starts the instant the
          feed says `update-available`) — so a staged runtime doesn't just
          vanish from the story: the "Next launch" row above still shows it,
          and this says why no restart button appeared yet. Same predicate as
          `isShellInstallInFlight` / `restartOffer`, so this note can't fall
          out of sync with either. */}
      {isShellAutoDownloadWindow(data.shell) && data.pendingVersion && (
        <p className="text-sm text-muted-foreground">
          Libi <span className="font-mono">{data.pendingVersion}</span> is ready for the
          next launch, and a new desktop app is downloading now
          {data.shell?.percent !== null && data.shell?.percent !== undefined
            ? ` — ${data.shell.percent}% — `
            : " — "}
          one restart will apply both.
        </p>
      )}

      {blocked && <BlockedCard blocked={blocked} />}

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
      {/* The whole auto-download window, not just `phase === "downloading"` — an
          auto-download shell starts fetching the instant its feed says
          `update-available`, so that state needs the same subject as the
          literal download, or the "Downloading" badge above points at nothing.
          Suppressed when a runtime is ALSO staged: the "one restart will apply
          both" note above already covers that variant by name. */}
      {isShellAutoDownloadWindow(data.shell) && !data.pendingVersion && (
        <p className="text-sm text-muted-foreground">
          Downloading Libi
          {data.shell?.latestVersion && (
            <>
              {" "}
              <span className="font-mono">{data.shell.latestVersion}</span>
            </>
          )}
          {data.shell?.percent !== null ? ` — ${data.shell?.percent}%` : "…"}
          {data.shell?.autoDownload
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
      {/* Suppressed while blocked: the runtime channel being current says
          nothing about the desktop app the user is stuck on, and the two
          lines together read as a contradiction. */}
      {!anyInstalling && !ready && !offer && !failed && !blocked && state === "up-to-date" && (
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
        {/* The always-works escape hatch. "Check again" above re-runs the
            write probe, so a user who fixes the location while Libi is open
            clears the block without restarting — this is for the ones who
            would rather just download it. */}
        {blocked && (
          <a
            href={RELEASES_URL}
            target="_blank"
            rel="noreferrer"
            className={cn(buttonVariants({ variant: "outline" }), "cursor-pointer")}
          >
            <ExternalLinkIcon className="size-4" />
            Download {blocked.version} manually
          </a>
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
