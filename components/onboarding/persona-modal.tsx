"use client";

import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { trackEvent } from "@/lib/analytics/client";

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

export function PersonaModal() {
  const qc = useQueryClient();
  const { data } = useQuery({
    queryKey: ["onboarding-state"],
    queryFn: async () => (await fetch("/api/onboarding/state")).json(),
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastPersona, setLastPersona] = useState<string | null>(null);

  // Funnel step 2 (Task 14): the persona question actually painted on
  // screen — not merely "the onboarding-state fetch resolved". Guarded by a
  // ref (not a render count) so React re-rendering the modal while it's
  // already up — including StrictMode's dev double-invoke of this same
  // effect — never double-fires it.
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
      await qc.invalidateQueries({ queryKey: ["onboarding-state"] });
      setSaving(false);
    } catch {
      setError("Couldn't save — check your connection and try again.");
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/95">
      <div className="w-full max-w-lg rounded-xl border border-border bg-card p-8 ring-1 ring-foreground/10">
        <h2 className="mb-1 text-2xl font-medium text-card-foreground">
          Welcome to libi
        </h2>
        <p className="mb-6 text-sm text-muted-foreground">
          Which best describes you?
        </p>
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
      </div>
    </div>
  );
}
