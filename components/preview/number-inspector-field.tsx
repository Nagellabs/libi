"use client";

import { useState } from "react";

/** A small labelled numeric field that commits on blur/Enter. */
export function NumberInspectorField({
  label,
  value,
  onCommit,
  suffix,
  testId,
  disabled,
}: {
  label: string;
  value: number;
  onCommit: (v: number) => void;
  suffix?: string;
  /** Override the default `inspector-${label}` test id. */
  testId?: string;
  /** Render read-only + dimmed (used by always-mounted, off-property fields). */
  disabled?: boolean;
}) {
  const [local, setLocal] = useState(String(value));
  // Mirror an external value change into the draft on the render where it
  // arrives (previous-state pattern) — no setState-in-effect cascade.
  const [prevValue, setPrevValue] = useState(value);
  if (value !== prevValue) {
    setPrevValue(value);
    setLocal(String(value));
  }
  return (
    <label className={`flex min-w-0 flex-col gap-1 text-[11px] ${disabled ? "opacity-50" : ""}`}>
      <span className="text-muted-foreground">{label}</span>
      <span className="flex min-w-0 items-center gap-1">
        <input
          data-testid={testId ?? `inspector-${label}`}
          value={local}
          disabled={disabled}
          onChange={(e) => setLocal(e.target.value)}
          onBlur={() => {
            const n = Number(local);
            if (Number.isFinite(n)) onCommit(n);
            else setLocal(String(value));
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.currentTarget as HTMLInputElement).blur();
          }}
          className="min-w-0 flex-1 rounded border border-border bg-background px-1.5 py-0.5 text-right font-mono tabular-nums text-foreground disabled:cursor-not-allowed"
          inputMode="decimal"
        />
        {suffix && <span className="shrink-0 text-muted-foreground">{suffix}</span>}
      </span>
    </label>
  );
}
