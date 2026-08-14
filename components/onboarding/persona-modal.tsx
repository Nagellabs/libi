"use client";

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

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

  if (!data || data.needsPersona !== true) return null;

  async function pick(persona: string) {
    setSaving(true);
    await fetch("/api/onboarding/persona", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ persona }),
    });
    await qc.invalidateQueries({ queryKey: ["onboarding-state"] });
    setSaving(false);
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
