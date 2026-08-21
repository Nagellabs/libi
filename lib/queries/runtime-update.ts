import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { JobStatusSnapshot } from "@/lib/jobs/types";

/**
 * The Settings → General "Version & updates" card, the app-wide update toast
 * and the sidebar's install indicator all read this one query.
 *
 * It reports TWO update channels, and `updateOffer()` below collapses them
 * into the single "Libi X is available" the user sees — they don't care
 * which half of the app got newer:
 *
 *  * `update` — the npm runtime (`@nagellabs/libi`), the weekly cadence.
 *    Installs in place via a JobManager job; applies at next launch.
 *  * `shell`  — the desktop app itself (electron-updater → GitHub Releases),
 *    the rare cadence. The shell downloads and restarts itself.
 *
 * Polling is deliberately asymmetric: while either channel has an install in
 * flight we poll every 2s so progress moves, and otherwise we do not poll at
 * all. The npm check is cached server-side for 6h and the shell re-checks
 * itself every 6h, so remounting Settings hits no network.
 */

export type UpdateState =
  | "unsupported"
  | "unknown"
  | "up-to-date"
  | "update-available"
  | "shell-update-required";

export interface UpdateStatusDto {
  state: UpdateState;
  currentVersion: string | null;
  latestVersion: string | null;
  latestShellApiVersion: number | null;
  checkedAt: number;
}

export type ShellUpdatePhase =
  | "idle"
  | "checking"
  | "up-to-date"
  | "update-available"
  | "downloading"
  | "ready"
  /**
   * An update exists and this install can't apply it — it's running from
   * somewhere its own bundle can't be replaced. Nothing was downloaded. The
   * one update state the user MUST see, because only they can fix it.
   */
  | "blocked"
  | "error";

export type ShellUpdateBlockedReason =
  | "translocated"
  | "running-from-dmg"
  | "not-in-applications"
  | "read-only-location";

export interface ShellUpdateStatusDto {
  phase: ShellUpdatePhase;
  currentVersion: string;
  latestVersion: string | null;
  /** 0–100 while downloading, else null. */
  percent: number | null;
  error: string | null;
  checkedAt: number | null;
  /** Which advice to show. Set only with `phase: "blocked"`. */
  blockedReason?: ShellUpdateBlockedReason | null;
  /** Where the app is running from — rendered verbatim; it is the evidence. */
  blockedPath?: string | null;
  /**
   * True when the shell downloads updates itself and parks at "ready" for
   * an explicit restart. Absent on old shells, which only download from a
   * click and restart themselves right after — the UI keeps the
   * click-to-install offer for those.
   */
  autoDownload?: boolean;
}

export interface RuntimeUpdateDto {
  current: {
    version: string | null;
    source: string;
    shellApiVersion: number | null;
  };
  shellApi: { min: number; max: number } | null;
  update: UpdateStatusDto;
  pendingVersion: string | null;
  install: (JobStatusSnapshot & { version: string | null }) | null;
  /** Null when this install has no desktop-shell update channel. */
  shell: ShellUpdateStatusDto | null;
}

export const runtimeUpdateKeys = { all: ["runtime-update"] as const };

export function isInstallInFlight(dto: RuntimeUpdateDto | undefined): boolean {
  const s = dto?.install?.status;
  return s === "queued" || s === "running" || s === "cancel-requested";
}

/** True while the SHELL is downloading / about to restart into its update. */
export function isShellInstallInFlight(dto: RuntimeUpdateDto | undefined): boolean {
  const shell = dto?.shell;
  if (!shell) return false;
  if (shell.phase === "downloading") return true;
  // "ready" is only transient on OLD shells (they restart themselves moments
  // later). On auto-download shells it is a stable waiting state — treating
  // it as in-flight would leave the 2s poll running forever.
  return shell.phase === "ready" && !shell.autoDownload;
}

/**
 * Since the auto-download change there are two distinct things the UI can
 * put in front of the user, and most of the time it is NEITHER — downloads
 * run silently:
 *
 *  * `restartOffer()` — a downloaded update waiting for its restart. The
 *    normal case; renders as "Libi X is ready — Restart to apply".
 *  * `updateOffer()` — a download that still needs a CLICK to start: a
 *    runtime auto-download that failed (Settings' "Try again"), or a shell
 *    update surfaced by an old shell that can't auto-download. The
 *    exception; renders as the legacy "Install & restart".
 *
 * Shell wins over runtime in both (a new shell bundles a fresh runtime
 * snapshot anyway, and the reverse order could install a runtime the OLD
 * shell can't run).
 */
export interface UpdateOffer {
  target: "runtime" | "shell";
  version: string;
}

export interface BlockedShellUpdate {
  version: string;
  reason: ShellUpdateBlockedReason;
  /** The path to show verbatim, or null if the shell didn't report one. */
  path: string | null;
}

/**
 * An update this install cannot apply from where it is running, or null.
 *
 * Unlike the two offers below, this is NOT dismissible in Settings or in the
 * sidebar — the user is pinned to their current version until they move the
 * app, and a message they can wave away is how the original bug (a log line
 * nobody reads) felt from the inside.
 */
export function blockedShellUpdate(
  dto: RuntimeUpdateDto | undefined,
): BlockedShellUpdate | null {
  const shell = dto?.shell;
  if (!shell || shell.phase !== "blocked" || !shell.latestVersion) return null;
  return {
    version: shell.latestVersion,
    reason: shell.blockedReason ?? "read-only-location",
    path: shell.blockedPath ?? null,
  };
}

/** A downloaded update waiting for a restart, or null. */
export function restartOffer(dto: RuntimeUpdateDto | undefined): UpdateOffer | null {
  const shell = dto?.shell;
  // Old shells (no autoDownload) restart themselves moments after "ready" —
  // that state renders as "Restarting…", never as an offer.
  if (shell && shell.phase === "ready" && shell.latestVersion && shell.autoDownload) {
    return { target: "shell", version: shell.latestVersion };
  }
  if (dto?.pendingVersion) {
    return { target: "runtime", version: dto.pendingVersion };
  }
  return null;
}

/** An update that still needs a click to DOWNLOAD, or null. */
export function updateOffer(dto: RuntimeUpdateDto | undefined): UpdateOffer | null {
  const shell = dto?.shell;
  if (
    shell &&
    shell.phase === "update-available" &&
    shell.latestVersion &&
    !shell.autoDownload
  ) {
    return { target: "shell", version: shell.latestVersion };
  }
  if (
    dto?.update.state === "update-available" &&
    dto.update.latestVersion &&
    // The server auto-downloads; a click is only useful after its attempt
    // failed. (While the download runs, `install` is queued/running and the
    // UI shows progress instead.)
    dto.install?.status === "failed" &&
    dto.pendingVersion !== dto.update.latestVersion
  ) {
    return { target: "runtime", version: dto.update.latestVersion };
  }
  return null;
}

async function fetchRuntimeUpdate(force = false): Promise<RuntimeUpdateDto> {
  const res = await fetch(`/api/runtime/update${force ? "?force=1" : ""}`);
  if (!res.ok) throw new Error(`runtime update fetch failed (${res.status})`);
  return res.json();
}

export function useRuntimeUpdate() {
  return useQuery({
    queryKey: runtimeUpdateKeys.all,
    queryFn: () => fetchRuntimeUpdate(false),
    // The server caches the registry answer; this keeps the client from
    // re-asking on every mount of a page that renders the sidebar.
    staleTime: 5 * 60 * 1000,
    // A failed CHECK is not a failed query — the route always answers 200 with
    // `state: "unknown"`. A rejection here means the app itself is unreachable,
    // and retrying that in a loop helps nobody.
    retry: false,
    refetchInterval: (query) => {
      const dto = query.state.data as RuntimeUpdateDto | undefined;
      return isInstallInFlight(dto) || isShellInstallInFlight(dto) ? 2000 : false;
    },
  });
}

/** "Check again" — bypasses the server-side cache, re-checks both channels. */
export function useRecheckRuntimeUpdate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => fetchRuntimeUpdate(true),
    onSuccess: (dto) => qc.setQueryData(runtimeUpdateKeys.all, dto),
  });
}

export interface InstallUpdateResponse {
  jobId?: string;
  version: string;
}

/**
 * "Restart to apply" — the click that applies a downloaded update.
 * Runtime target: the same server reset the MCPs & Skills "Restart server"
 * button uses (`app.relaunch()` in the packaged shell). Shell target: the
 * update route relays to the shell's `restart()` and it quits-and-installs.
 */
export function useRestartToApply() {
  return useMutation({
    mutationFn: async (offer: UpdateOffer): Promise<void> => {
      if (offer.target === "shell") {
        const res = await fetch("/api/runtime/update", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ version: offer.version, target: "shell", action: "restart" }),
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { message?: string };
          throw new Error(body.message ?? `Restart failed to start (${res.status})`);
        }
        return;
      }
      const res = await fetch("/api/server-status/reset", { method: "POST" });
      if (!res.ok) throw new Error(`Restart failed to start (${res.status})`);
    },
  });
}

export function useInstallRuntimeUpdate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (offer: UpdateOffer): Promise<InstallUpdateResponse> => {
      const res = await fetch("/api/runtime/update", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(offer),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { message?: string };
        throw new Error(body.message ?? `Update failed to start (${res.status})`);
      }
      return res.json();
    },
    // Refetch immediately so the card flips to "installing" without waiting
    // for the poll interval to come round.
    onSettled: () => qc.invalidateQueries({ queryKey: runtimeUpdateKeys.all }),
  });
}
