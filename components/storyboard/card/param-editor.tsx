"use client";

import { useState } from "react";
import type { ParamView } from "@/lib/storyboard/param-view";
import type { GenParamValue } from "@/lib/storyboard/types";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover";

interface ParamEditorProps {
  param: ParamView;
  error?: string;
  onCommit: (value: GenParamValue) => void;
}

/** Click-to-edit popover for a text param: shows one truncated line; clicking
 *  opens a popover with the full value in a textarea to edit (Save commits, Esc /
 *  Cancel discards). Preferred over an inline input for long text like prompts. */
function TextParamEditor({ param, error, onCommit }: ParamEditorProps) {
  const initial = Array.isArray(param.value) ? param.value.join(", ") : String(param.value);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(initial);
  const display = initial.trim() || "—";

  return (
    <div className="flex min-w-0 flex-col items-end gap-0.5">
      <Popover
        open={open}
        onOpenChange={(o) => {
          setOpen(o);
          if (o) setDraft(initial); // re-sync to the latest value when opening
        }}
      >
        <PopoverTrigger
          render={
            <button
              type="button"
              className="cursor-pointer max-w-[160px] truncate rounded px-1 py-0.5 text-right text-[11px] text-foreground/90 hover:bg-muted"
              title={display}
            />
          }
        >
          {display}
        </PopoverTrigger>
        <PopoverContent className="w-[300px]">
          <div className="mb-1 text-[10px] uppercase tracking-wider text-muted-foreground/60">
            {param.label}
          </div>
          <textarea
            value={draft}
            autoFocus
            rows={5}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") setOpen(false);
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                onCommit(draft);
                setOpen(false);
              }
            }}
            className="w-full resize-y rounded border border-input bg-transparent px-2 py-1.5 text-[12px] outline-none focus-visible:border-ring"
          />
          <div className="mt-1.5 flex items-center justify-end gap-1.5">
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="cursor-pointer rounded px-2 py-1 text-[11px] text-muted-foreground hover:bg-muted"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => {
                onCommit(draft);
                setOpen(false);
              }}
              className="cursor-pointer rounded bg-blue-500 px-2 py-1 text-[11px] text-white hover:bg-blue-600"
            >
              Save
            </button>
          </div>
        </PopoverContent>
      </Popover>
      {error && <span className="text-[10px] text-red-400">{error}</span>}
    </div>
  );
}

/** Typed editor for a single non-media param. Boolean + enum commit immediately;
 *  text opens a click-to-edit popover; number commits on blur/Enter (Esc reverts).
 *  Enums use a native <select> (compact + keyboard-friendly for a tiny control). */
export function ParamEditor({ param, error, onCommit }: ParamEditorProps) {
  const [draft, setDraft] = useState<string>(
    Array.isArray(param.value) ? param.value.join(", ") : String(param.value),
  );

  // Boolean → switch (commit on toggle)
  if (param.type === "boolean") {
    return (
      <div className="flex flex-col items-end gap-0.5">
        <Switch
          checked={param.value === true}
          onCheckedChange={(v) => onCommit(v)}
          className="cursor-pointer"
        />
        {error && <span className="text-[10px] text-red-400">{error}</span>}
      </div>
    );
  }

  // Enum / constrained options → native select (commit on change)
  if (param.options && param.options.length > 0) {
    return (
      <div className="flex flex-col items-end gap-0.5">
        <select
          value={String(param.value)}
          onChange={(e) =>
            onCommit(param.type === "number" ? Number(e.target.value) : e.target.value)
          }
          className="cursor-pointer h-6 w-[124px] rounded border border-input bg-transparent px-1 text-right text-[11px] outline-none focus-visible:border-ring"
        >
          {param.options.map((o) => (
            <option key={String(o)} value={String(o)}>
              {String(o)}
            </option>
          ))}
        </select>
        {error && <span className="text-[10px] text-red-400">{error}</span>}
      </div>
    );
  }

  // Text-like (prompt, url, etc.) → click-to-edit popover (one line + full editor)
  if (param.type !== "number") {
    return <TextParamEditor param={param} error={error} onCommit={onCommit} />;
  }

  // Number → inline input (commit on blur/Enter, Esc reverts)
  const commit = () => {
    if (param.type === "number") {
      const n = Number(draft);
      if (!Number.isNaN(n)) onCommit(n);
    } else {
      onCommit(draft);
    }
  };

  return (
    <div className="flex flex-col items-end gap-0.5">
      <Input
        type={param.type === "number" ? "number" : "text"}
        value={draft}
        min={param.min}
        max={param.max}
        step={param.step}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.currentTarget.blur();
          }
          if (e.key === "Escape") {
            setDraft(Array.isArray(param.value) ? param.value.join(", ") : String(param.value));
            e.currentTarget.blur();
          }
        }}
        className="h-6 w-[124px] text-right text-[11px]"
      />
      {error && <span className="text-[10px] text-red-400">{error}</span>}
    </div>
  );
}
