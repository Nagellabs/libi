"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { Dialog } from "@base-ui/react/dialog";
import { trackEvent } from "@/lib/analytics/client";
import { RETURN_TO_PARAM, safeReturnPath } from "@/lib/onboarding/return-to";
import { onboardingKeys, useOnboardingState, type OnboardingState } from "@/lib/queries/onboarding";

const OPTIONS: Array<{ id: string; label: string }> = [
  { id: "solo-creator", label: "Solo creator" },
  { id: "entrepreneur", label: "Entrepreneur / founder" },
  { id: "video-editor", label: "Video editor" },
  { id: "marketing", label: "Marketing / growth" },
  { id: "agency", label: "Agency" },
  { id: "studio", label: "Studio / production" },
  { id: "developer", label: "Developer" },
  { id: "curious", label: "Just curious" },
];

/**
 * The first-launch persona question. It is mounted on the Agents page — a first
 * launch is routed there before the editor paints (`FirstLaunchGate`) — so it
 * sits on top of the Agents tab, where setup continues once it is answered.
 *
 * base-ui's modal dialog keeps keyboard focus inside it and hides the page
 * behind from assistive tech, so nothing on the Agents tab — a wizard's agent
 * pick included — can be reached before the question is answered. It cannot be
 * dismissed: neither Escape nor a click outside closes it.
 */
export function PersonaModal() {
  const qc = useQueryClient();
  const router = useRouter();
  const { data } = useOnboardingState();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastPersona, setLastPersona] = useState<string | null>(null);

  // Funnel step 2: the persona question actually painted on screen — not merely
  // "the onboarding-state fetch resolved". Guarded by a ref (not a render count)
  // so React re-rendering the modal while it's already up — including
  // StrictMode's dev double-invoke of this same effect — never double-fires it.
  const shownRef = useRef(false);
  useEffect(() => {
    if (data?.needsPersona !== true) return;
    if (shownRef.current) return;
    shownRef.current = true;
    trackEvent("persona_prompt_shown");
  }, [data?.needsPersona]);

  if (!data || data.needsPersona !== true) return null;

  async function pick(persona: string) {
    setSaving(true);
    setError(null);
    setLastPersona(persona);
    try {
      const res = await fetch("/api/onboarding/persona", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ persona }),
      });
      if (!res.ok) {
        setError(`Couldn't save — the server rejected the request (${res.status}).`);
        setSaving(false);
        return;
      }
      // The refreshed state no longer needs a persona, which closes the modal.
      // The Agents tab it was covering is where setup goes on — unless the user
      // was opening a page when the question interrupted them: then back to it,
      // once the cache agrees the question is answered (or the editor's gate
      // would send them straight back here).
      await qc.invalidateQueries({ queryKey: onboardingKeys.state });
      setSaving(false);
      const returnTo = safeReturnPath(
        new URLSearchParams(window.location.search).get(RETURN_TO_PARAM),
        window.location.origin,
      );
      const answered = qc.getQueryData<OnboardingState>(onboardingKeys.state)?.needsPersona === false;
      if (returnTo !== null && answered) router.replace(returnTo);
    } catch {
      setError("Couldn't save — check your connection and try again.");
      setSaving(false);
    }
  }

  return (
    <Dialog.Root open modal disablePointerDismissal>
      <Dialog.Portal>
        <Dialog.Backdrop data-testid="persona-modal-backdrop" className="fixed inset-0 z-50 bg-background/80 backdrop-blur-sm" />
        <Dialog.Popup
          aria-modal="true"
          data-testid="persona-modal"
          className="fixed top-1/2 left-1/2 z-50 w-full max-w-lg -translate-x-1/2 -translate-y-1/2 rounded-xl border border-border bg-card p-8 ring-1 ring-foreground/10 outline-none"
        >
          <Dialog.Title className="mb-1 text-2xl font-medium text-card-foreground">Welcome to libi</Dialog.Title>
          <Dialog.Description className="mb-6 text-sm text-muted-foreground">Which best describes you?</Dialog.Description>
          {error && (
            <div className="mb-4 flex items-center justify-between gap-3 rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
              <span>{error}</span>
              <button
                disabled={saving}
                onClick={() => lastPersona && pick(lastPersona)}
                className="cursor-pointer shrink-0 rounded-md border border-destructive/40 px-3 py-1 font-medium hover:bg-destructive/20 disabled:cursor-not-allowed disabled:opacity-50"
              >
                Retry
              </button>
            </div>
          )}
          <div className="grid grid-cols-2 gap-3">
            {OPTIONS.map((o) => (
              <button
                key={o.id}
                disabled={saving}
                onClick={() => pick(o.id)}
                className="cursor-pointer rounded-lg border border-border px-4 py-3 text-left text-sm text-card-foreground hover:bg-accent hover:text-accent-foreground disabled:cursor-not-allowed disabled:opacity-50"
              >
                {o.label}
              </button>
            ))}
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
