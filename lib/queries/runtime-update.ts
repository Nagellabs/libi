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
  | "error";

export interface ShellUpdateStatusDto {
  phase: ShellUpdatePhase;
  currentVersion: string;
  latestVersion: string | null;
  /** 0–100 while downloading, else null. */
  percent: number | null;
  error: string | null;
  checkedAt: number | null;
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
  const p = dto?.shell?.phase;
  return p === "downloading" || p === "ready";
}

/**
 * The one thing the user is offered, regardless of channel.
 *
 * The shell wins when both channels have something: a new shell bundles a
 * fresh runtime snapshot anyway, and the reverse order could install a
 * runtime the OLD shell can't run. It also covers `shell-update-required`
 * (a runtime this shell can't load) — the shell update IS that state's
 * remedy, turning its passive "go download a new Libi" copy into a button.
 */
export interface UpdateOffer {
  target: "runtime" | "shell";
  version: string;
}

export function updateOffer(dto: RuntimeUpdateDto | undefined): UpdateOffer | null {
  const shell = dto?.shell;
  if (shell && shell.phase === "update-available" && shell.latestVersion) {
    return { target: "shell", version: shell.latestVersion };
  }
  if (dto?.update.state === "update-available" && dto.update.latestVersion) {
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
