"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import {
  isInstallInFlight,
  updateOffer,
  useInstallRuntimeUpdate,
  useRuntimeUpdate,
} from "@/lib/queries/runtime-update";
import { useResetServer } from "@/lib/queries/server-status";

/**
 * The app-wide update offer — a persistent, dismissible toast that appears
 * anywhere in the app when a newer Libi is installable, so an update is
 * visible without opening Settings. It complements, never replaces, the two
 * existing surfaces that read the same query: the sidebar indicator (passive)
 * and the Settings → General card (always available, including after a
 * dismiss).
 *
 * Behaviour rules:
 *  - One offer, either channel. `updateOffer()` collapses "newer npm
 *    runtime" and "newer desktop shell" into a single "Libi X is available";
 *    the user doesn't care which half of the app got newer. Nothing shows in
 *    dev / npx (no offer is ever computed there).
 *  - Dismissing (the X) remembers THAT VERSION for THIS APP LAUNCH ONLY
 *    (sessionStorage): the toast stays gone for the rest of the session and
 *    comes back at the next launch, so a dismissed update nags gently
 *    instead of being forgotten forever. The Settings card is the immediate
 *    recovery path.
 *  - "Install & restart" means it: a runtime install started HERE
 *    auto-restarts the app when the download completes (the reset mutation's
 *    idle state is the fired-once guard, same as updates-section.tsx), and a
 *    shell install restarts itself from the main process once verified.
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
  const install = useInstallRuntimeUpdate();
  const reset = useResetServer();
  const router = useRouter();

  // Consent: true only when the install was started from THIS toast in THIS
  // session — the same rule updates-section.tsx applies to its button.
  const [installedHere, setInstalledHere] = useState(false);

  // Memoized so the effect below keys on the offer's CONTENT — updateOffer
  // returns a fresh object every call, and React Query's structural sharing
  // keeps `data` stable between identical polls.
  const offer = useMemo(() => updateOffer(data), [data]);
  const pendingVersion = data?.pendingVersion ?? null;
  const shellPhase = data?.shell?.phase ?? null;
  const shellPercent = data?.shell?.percent ?? null;
  const installing = isInstallInFlight(data) || install.isPending;

  // Auto-restart once the RUNTIME install this toast started has landed on
  // disk. Shell installs restart themselves from the main process.
  useEffect(() => {
    if (!pendingVersion || !installedHere || !reset.isIdle) return;
    reset.mutate();
  }, [pendingVersion, installedHere, reset]);

  useEffect(() => {
    // Progress states for an install started here — keep the same toast id
    // so the offer morphs in place instead of stacking.
    if (installedHere) {
      if (pendingVersion || shellPhase === "ready") {
        toast.loading("Restarting Libi…", { id: UPDATE_TOAST_ID, duration: Infinity });
      } else if (shellPhase === "downloading") {
        toast.loading(
          `Downloading the new Libi${shellPercent !== null ? ` — ${shellPercent}%` : "…"}`,
          { id: UPDATE_TOAST_ID, duration: Infinity },
        );
      } else if (installing) {
        toast.loading(
          "Downloading the new Libi… Libi keeps working and restarts when it's ready.",
          { id: UPDATE_TOAST_ID, duration: Infinity },
        );
      }
      return;
    }

    if (!offer || pendingVersion || installing || shellPhase === "downloading" || shellPhase === "ready") {
      return;
    }
    if (readDismissedVersion() === offer.version) return;

    toast(`Libi ${offer.version} is available`, {
      id: UPDATE_TOAST_ID,
      duration: Infinity,
      closeButton: true,
      description: "Installs in the background, then Libi restarts by itself.",
      action: {
        label: "Install & restart",
        onClick: () => {
          setInstalledHere(true);
          install.mutate(offer);
          // Land the user where the action is visible: the Settings Version
          // section, which flashes on arrival (see updates-section.tsx) and
          // shows the live install state — so the click never feels like the
          // toast just vanished.
          router.push("/settings?highlight=version");
        },
      },
      // Fires on the X (and swipe) only — action clicks don't run it, so an
      // install is never mistaken for a dismissal.
      onDismiss: () => rememberDismissed(offer.version),
    });
  }, [offer, pendingVersion, installing, shellPhase, shellPercent, installedHere, install, router]);

  return null;
}
