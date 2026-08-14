"use client";

import { useCallback, useState } from "react";
import { Group, Panel, Separator } from "react-resizable-panels";
import { useEditorState } from "@/lib/editor-state-context";
import type { PersistedScript } from "@/lib/analysis/scripts";
import type { JobStatusSnapshot } from "@/lib/jobs/types";
import { ScriptOverviewStrip } from "./script-overview-strip";
import { ScriptShotRail } from "./script-shot-rail";
import { ScriptShotDetail } from "./script-shot-detail";
import { ScriptSoundDesign } from "./script-sound-design";

interface Props {
  persisted: PersistedScript;
  onSeek: (t: number) => void;
  currentTime: number;
  onRegenerate: () => void;
  /** Set while a regenerate job is running on top of an already-populated script. */
  regeneratingJob?: JobStatusSnapshot;
  onCancel?: () => void;
}

export function ScriptPanel({
  persisted,
  onSeek,
  currentTime,
  onRegenerate,
  regeneratingJob,
  onCancel,
}: Props) {
  const { scriptShotRailPct, setScriptShotRailPct } = useEditorState();
  const shots = persisted.script.shots ?? [];
  const sound = persisted.script.sound_design ?? [];
  const [selectedIdx, setSelectedIdx] = useState(0);

  const handleLayoutChanged = useCallback(
    (layout: { [id: string]: number }) => {
      const left = layout.left;
      if (typeof left === "number" && left > 10 && left < 90) {
        setScriptShotRailPct(left);
      }
    },
    [setScriptShotRailPct],
  );

  return (
    <div className="flex h-full flex-col">
      <ScriptOverviewStrip persisted={persisted} onRegenerate={onRegenerate} onSeek={onSeek} />

      {regeneratingJob && (
        <div className="flex items-center justify-between gap-2 border-b border-amber-500/30 bg-amber-500/10 px-4 py-1.5 text-xs">
          <span>
            ⏳ Regenerating
            {regeneratingJob.progressUnit
              ? ` (${regeneratingJob.progressDone}/${regeneratingJob.progressTotal} ${regeneratingJob.progressUnit})`
              : "…"}
          </span>
          {onCancel && (
            <button
              type="button"
              onClick={onCancel}
              className="cursor-pointer rounded-md border border-border bg-muted px-2 py-0.5 text-xs hover:bg-surface-hover"
            >
              Cancel
            </button>
          )}
        </div>
      )}

      <div className="flex-1 min-h-0">
        <Group
          orientation="horizontal"
          defaultLayout={{ left: scriptShotRailPct, right: 100 - scriptShotRailPct }}
          onLayoutChanged={handleLayoutChanged}
          className="h-full"
        >
          <Panel id="left" minSize={20}>
            <ScriptShotRail
              shots={shots}
              selectedIdx={selectedIdx}
              currentTime={currentTime}
              onSelect={setSelectedIdx}
              onSeek={onSeek}
            />
          </Panel>
          <Separator className="group relative w-px bg-border transition-colors hover:bg-primary/60 data-[active]:bg-primary">
            <div className="absolute -left-1 -right-1 inset-y-0 z-10 group-hover:cursor-col-resize" />
          </Separator>
          <Panel id="right" minSize={20}>
            {shots[selectedIdx] ? (
              <ScriptShotDetail shot={shots[selectedIdx]} />
            ) : (
              <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
                No shots in this script.
              </div>
            )}
          </Panel>
        </Group>
      </div>

      <ScriptSoundDesign entries={sound} onSeek={onSeek} />
    </div>
  );
}
