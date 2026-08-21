"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import {
  blockedShellUpdate,
  isShellInstallInFlight,
  restartOffer,
  updateOffer,
  useInstallRuntimeUpdate,
  useRestartToApply,
  useRuntimeUpdate,
} from "@/lib/queries/runtime-update";

/**
 * The app-wide update toast. Since the auto-download change, downloads run
 * silently — the toast's normal job is to announce a FINISHED download:
 *
 *     "Libi X is ready — Restart to apply"  [Restart now]
 *
 * It complements, never replaces, the two other surfaces reading the same
 * query: the sidebar indicator (passive) and the Settings → General card
 * (always available, including after a dismiss). Nothing shows in dev / npx.
 *
 * Behaviour rules:
 *  - One offer, either channel. `restartOffer()` collapses "runtime staged
 *    for next launch" and "shell downloaded and parked at ready" into one
 *    "Libi X is ready"; the user doesn't care which half got newer.
 *  - Dismissing (the X) remembers THAT VERSION for THIS APP LAUNCH ONLY
 *    (sessionStorage): the toast stays gone for the rest of the session and
 *    comes back at the next launch — which, for a runtime update, is also
 *    the launch that applies it.
 *  - "Restart now" means now: the runtime target resets the server (the app
 *    reloads into the new version), the shell target quits-and-installs.
 *  - Legacy path: an OLD desktop shell (no autoDownload) cannot download a
 *    shell update itself, so a shell offer from one keeps the click-to-
 *    install toast ("Install & restart") this component always had.
 *  - Blocked: an update exists that this install cannot apply from where it
 *    is running. The toast says so and links to the explanation — it must
 *    NOT offer an install, because offering an action that cannot succeed is
 *    the bug this whole change exists to fix, wearing a nicer hat. Dismiss
 *    is session-only here as everywhere; the Settings card and the sidebar
 *    dot are the surfaces that don't go away until the user fixes it.
 */

/** sessionStorage key holding the version dismissed this app launch. */
export const UPDATE_TOAST_DISMISS_KEY = "libi.update-toast-dismissed-version";
/** Stable toast id so re-renders update one toast instead of stacking. */
export const UPDATE_TOAST_ID = "libi-runtime-update";

function readDismissedVersion(): string | null {
  try {
    return sessionStorage.getItem(UPDATE_TOAST_DISMISS_KEY);
  } catch {
    return null;
  }
}

function rememberDismissed(version: string): void {
  try {
    sessionStorage.setItem(UPDATE_TOAST_DISMISS_KEY, version);
  } catch {
    /* a storage failure just means the toast reappears sooner */
  }
}

export function UpdateToast() {
  const { data } = useRuntimeUpdate();
  const router = useRouter();
  const restart = useRestartToApply();
  const install = useInstallRuntimeUpdate();

  // Set when a restart (or a legacy shell install) was started from THIS
  // toast — from then on it only morphs through progress copy.
  const [actedHere, setActedHere] = useState(false);

  // Memoized so the effect keys on the offers' CONTENT — both helpers
  // return fresh objects per call while React Query's structural sharing
  // keeps `data` stable between identical polls.
  const ready = useMemo(() => restartOffer(data), [data]);
  const legacyOffer = useMemo(() => {
    const offer = updateOffer(data);
    // The toast only carries the legacy click for the OLD-shell case; a
    // failed runtime auto-download surfaces in Settings (and the sidebar
    // dot), not as a toast at every launch.
    return offer?.target === "shell" ? offer : null;
  }, [data]);
  const blocked = useMemo(() => blockedShellUpdate(data), [data]);
  const shellPhase = data?.shell?.phase ?? null;
  const shellPercent = data?.shell?.percent ?? null;

  useEffect(() => {
    if (actedHere) {
      // Progress copy for an action started here, morphing in place.
      if (restart.isPending || restart.isSuccess || shellPhase === "ready") {
        toast.loading("Restarting Libi…", { id: UPDATE_TOAST_ID, duration: Infinity });
      } else if (shellPhase === "downloading") {
        // Legacy shell install: download, then the old shell restarts itself.
        toast.loading(
          `Downloading the new Libi${shellPercent !== null ? ` — ${shellPercent}%` : "…"}`,
          { id: UPDATE_TOAST_ID, duration: Infinity },
        );
      }
      return;
    }

    // Blocked outranks both offers: there is nothing to restart into and
    // nothing a click here could download.
    if (blocked) {
      if (readDismissedVersion() === blocked.version) return;
      toast(`Libi ${blocked.version} is available`, {
        id: UPDATE_TOAST_ID,
        duration: Infinity,
        closeButton: true,
        description: "It can't be installed from where Libi is running.",
        action: {
          label: "Why can't I update?",
          onClick: () => router.push("/settings?highlight=version"),
        },
        onDismiss: () => rememberDismissed(blocked.version),
      });
      return;
    }

    const offer = ready ?? legacyOffer;
    if (!offer || isShellInstallInFlight(data)) return;
    if (readDismissedVersion() === offer.version) return;

    if (ready) {
      toast(`Libi ${ready.version} is ready`, {
        id: UPDATE_TOAST_ID,
        duration: Infinity,
        closeButton: true,
        description: "It downloaded in the background — restart to apply it.",
        action: {
          label: "Restart now",
          onClick: () => {
            setActedHere(true);
            restart.mutate(ready);
          },
        },
        // Fires on the X (and swipe) only — action clicks don't run it.
        onDismiss: () => rememberDismissed(ready.version),
      });
      return;
    }

    // Legacy: an old shell offering a shell update it can't download itself.
    toast(`Libi ${legacyOffer!.version} is available`, {
      id: UPDATE_TOAST_ID,
      duration: Infinity,
      closeButton: true,
      description: "Installs in the background, then Libi restarts by itself.",
      action: {
        label: "Install & restart",
        onClick: () => {
          setActedHere(true);
          install.mutate(legacyOffer!);
        },
      },
      onDismiss: () => rememberDismissed(legacyOffer!.version),
    });
  }, [
    ready,
    legacyOffer,
    blocked,
    data,
    shellPhase,
    shellPercent,
    actedHere,
    restart,
    install,
    router,
  ]);

  return null;
}
