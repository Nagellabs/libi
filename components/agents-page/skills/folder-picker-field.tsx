"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { pickFolder } from "@/lib/shell/client";

const UNAVAILABLE_HINT = "Couldn't open a folder dialog here — paste the path instead.";
const BUSY_HINT = "A folder dialog is already open.";

/**
 * A path field with a native "Choose folder…" beside it. Picking fills the
 * field; the user may paste a path instead; the submit button acts on the
 * field. The dialog comes from the Electron bridge in the desktop app and
 * from libi's own server in a browser — when neither can open one, the field
 * is the way in.
 */
export function FolderPickerField({
  value,
  onChange,
  onSubmit,
  submitLabel,
  submitting = false,
  error = null,
  testId = "folder-picker",
}: {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  submitLabel: string;
  submitting?: boolean;
  error?: string | null;
  testId?: string;
}) {
  const [picking, setPicking] = useState(false);
  const [hint, setHint] = useState<string | null>(null);
  const canSubmit = value.trim().length > 0 && !submitting;

  // The dialog is a separate window (Electron's native picker, or one opened
  // by libi's own server) that can outlive this field: Cancel unmounts the
  // field while a pick is still pending, and a result arriving after that
  // must not call the parent's setter — the parent's state would carry a
  // stale path into whatever reopens the field next.
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const choose = async () => {
    setPicking(true);
    setHint(null);
    try {
      const result = await pickFolder(value.trim() ? value.trim() : undefined);
      if (!alive.current) return;
      if (result.status === "picked") onChange(result.path);
      else if (result.status === "unavailable") setHint(UNAVAILABLE_HINT);
      else if (result.status === "busy") setHint(BUSY_HINT);
    } finally {
      if (alive.current) setPicking(false);
    }
  };

  return (
    <div data-testid={testId} className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <Input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && canSubmit) onSubmit();
          }}
          placeholder="/path/to/your/project"
          aria-label="Folder path"
          className="min-w-0 flex-1 font-mono text-xs"
        />
        <Button type="button" variant="outline" size="sm" className="cursor-pointer" disabled={picking} onClick={() => void choose()}>
          Choose folder…
        </Button>
        <Button type="button" size="sm" className="cursor-pointer" disabled={!canSubmit} onClick={onSubmit}>
          {submitLabel}
        </Button>
      </div>
      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
