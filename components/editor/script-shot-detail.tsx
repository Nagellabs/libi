"use client";

import type { Shot } from "@/lib/analysis/types";
import { formatTimecode } from "@/lib/utils/format";

export function ScriptShotDetail({ shot }: { shot: Shot }) {
  const duration = Math.max(0, shot.end - shot.start);
  const hasAction = !!shot.action && shot.action.trim().length > 0;
  const hasDialogue = !!shot.dialogue && shot.dialogue.trim().length > 0;
  const hasLighting = !!shot.lighting && shot.lighting.trim().length > 0;
  const hasMood = !!shot.mood && shot.mood.trim().length > 0;
  const cam = shot.camera ?? {};

  return (
    <div className="flex h-full flex-col gap-3 overflow-auto px-4 py-3">
      <header className="flex items-baseline gap-3">
        <h3 className="text-sm font-semibold text-foreground">
          Shot {shot.index + 1}
        </h3>
        <span className="text-xs text-muted-foreground">
          {formatTimecode(shot.start)} – {formatTimecode(shot.end)}{" "}
          <span className="opacity-70">({duration.toFixed(1)}s)</span>
        </span>
      </header>

      <p className="text-sm leading-relaxed text-foreground whitespace-pre-wrap">
        {shot.description}
      </p>

      <div className="grid grid-cols-3 gap-2 rounded-md border border-border bg-muted/40 p-3">
        <DetailCol label="Camera">
          {cam.shot && <Line value={cam.shot} />}
          {cam.angle && <Line value={cam.angle} />}
          {cam.motion && <Line value={cam.motion} />}
        </DetailCol>
        {hasLighting && (
          <DetailCol label="Lighting">
            <Line value={shot.lighting!} />
          </DetailCol>
        )}
        {hasMood && (
          <DetailCol label="Mood">
            <Line value={shot.mood!} />
          </DetailCol>
        )}
      </div>

      {hasAction && (
        <DetailRow label="Action" value={shot.action!} />
      )}

      {hasDialogue && (
        <DetailRow label="Dialogue" value={shot.dialogue!} />
      )}

      {shot.transition_out && (
        <DetailRow label="Transition" value={`→ ${shot.transition_out}`} />
      )}
    </div>
  );
}

function DetailCol({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1">
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      {children}
    </div>
  );
}

function Line({ value }: { value: string }) {
  return <div className="text-xs text-foreground">{value}</div>;
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid grid-cols-[120px_1fr] items-baseline gap-3">
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div className="text-sm text-foreground whitespace-pre-wrap">{value}</div>
    </div>
  );
}
