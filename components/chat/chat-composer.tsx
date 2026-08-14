"use client";

import { useState, useRef, useEffect, type FormEvent, type DragEvent, type KeyboardEvent } from "react";
import { ArrowUp, Plus, X } from "lucide-react";
import FileThumbnail from "./file-thumbnail";
import PermissionModePicker from "./permission-mode-picker";
import ModelPicker from "./model-picker";
import ContextUsageChip from "./context-usage-chip";
import CommandPalette from "./command-palette";
import {
  filterCommands,
  shouldShowPalette,
  completionText,
  type PaletteCommand,
} from "@/lib/chat/slash-commands";
import { useSessionContext } from "@/lib/queries/session-context";
import { useEditorState } from "@/lib/editor-state-context";

interface ChatComposerProps {
  inputValue: string;
  onInputChange: (value: string) => void;
  pendingFiles: File[];
  /**
   * Receives an already-materialized `File[]`. The caller MUST NOT pass a
   * raw `FileList` because the source FileList is live — calling
   * `e.target.value = ""` (to allow re-selecting the same file) empties it
   * synchronously, and any deferred read inside a React state updater
   * would see zero files. Snapshot via `Array.from(...)` in the event
   * handler before any state mutation.
   */
  onFilesSelected: (files: File[]) => void;
  onRemoveFile: (index: number) => void;
  onClearFiles: () => void;
  onSubmit: (e: FormEvent) => void;
  /** Called when the user clicks the Stop button while streaming. */
  onCancel: () => void;
  disabled: boolean;
  canSend: boolean;
  /** True when the agent is mid-turn (thinking or streaming).
   *  Morphs the Send button into a Stop button.
   *  Textarea stays enabled so the user can type a steer prompt. */
  isStreaming: boolean;
  /** Active session id — drives the per-session model picker. */
  sessionId: string | null;
}

/** Max textarea height before scrolling kicks in (~10 lines) */
const MAX_HEIGHT = 200;

export default function ChatComposer({
  inputValue,
  onInputChange,
  pendingFiles,
  onFilesSelected,
  onRemoveFile,
  onClearFiles,
  onSubmit,
  onCancel,
  disabled,
  canSend,
  isStreaming,
  sessionId,
}: ChatComposerProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isDragOver, setIsDragOver] = useState(false);
  const { viewMode } = useEditorState();

  const inSnapshotView = viewMode === "snapshot";

  // Command palette state. `dismissed` closes the palette after Esc without
  // reopening on the next keystroke within the same token; it resets once the
  // input no longer starts with "/". `shouldShowPalette` stays pure.
  const { commands } = useSessionContext(sessionId);
  const [paletteIndex, setPaletteIndex] = useState(0);
  const [caretPos, setCaretPos] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const paletteOpen =
    !disabled &&
    !inSnapshotView &&
    !dismissed &&
    shouldShowPalette(inputValue, caretPos);
  const paletteCommands = paletteOpen ? filterCommands(inputValue, commands) : [];

  // `dismissed` must reset on ANY path that leaves slash-command territory —
  // including programmatic clears (submit sets inputValue to "" without an
  // onChange event), or the stale flag would suppress the palette for the
  // NEXT slash command typed after sending one. Render-time adjustment (the
  // React-sanctioned "adjusting state when a prop changes" pattern) so the
  // reset applies in the same pass, effect-free.
  const [prevInputValue, setPrevInputValue] = useState(inputValue);
  if (prevInputValue !== inputValue) {
    setPrevInputValue(inputValue);
    if (dismissed && !inputValue.startsWith("/")) setDismissed(false);
  }

  const pickCommand = (command: PaletteCommand) => {
    onInputChange(completionText(command));
    setPaletteIndex(0);
    // Picking completes the choice: close the palette so the NEXT Enter
    // submits. Without this, a no-arg pick ("/clear" — no trailing space)
    // leaves the caret inside the first token, the palette re-opens, and
    // Enter re-picks the same row forever instead of submitting.
    setDismissed(true);
    // Caret lands at end of the inserted text on the next frame.
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (el) {
        el.focus();
        el.selectionStart = el.selectionEnd = el.value.length;
        setCaretPos(el.value.length);
      }
    });
  };

  // Auto-resize textarea to content
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT)}px`;
  }, [inputValue]);

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // Command palette navigation takes priority while open. Keys pressed
    // mid-IME-composition (CJK input) belong to the composer, never the
    // palette.
    if (paletteOpen && paletteCommands.length > 0 && !e.nativeEvent.isComposing) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setPaletteIndex((i) => (i + 1) % paletteCommands.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setPaletteIndex((i) => (i - 1 + paletteCommands.length) % paletteCommands.length);
        return;
      }
      if (e.key === "Home" || e.key === "PageUp") {
        e.preventDefault();
        setPaletteIndex(0);
        return;
      }
      if (e.key === "End" || e.key === "PageDown") {
        e.preventDefault();
        setPaletteIndex(paletteCommands.length - 1);
        return;
      }
      if (e.key === "Tab" || e.key === "Enter") {
        e.preventDefault();
        pickCommand(paletteCommands[Math.min(paletteIndex, paletteCommands.length - 1)]);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        // Close without inserting; stays closed until the input no longer
        // starts with "/" (the inputValue effect above resets the flag).
        setDismissed(true);
        return;
      }
    }

    // Enter sends, Shift/Alt/Ctrl+Enter inserts newline
    if (e.key === "Enter" && !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey) {
      e.preventDefault();
      if (canSend) {
        onSubmit(e as unknown as FormEvent);
      }
      return;
    }

    // Alt+Enter or Ctrl+Enter: insert newline (some platforms need explicit handling)
    if (e.key === "Enter" && (e.altKey || e.ctrlKey)) {
      e.preventDefault();
      const el = textareaRef.current;
      if (!el) return;
      const start = el.selectionStart;
      const end = el.selectionEnd;
      const val = inputValue;
      onInputChange(val.slice(0, start) + "\n" + val.slice(end));
      // Restore cursor after React re-render
      requestAnimationFrame(() => {
        el.selectionStart = el.selectionEnd = start + 1;
      });
    }
  };

  const handleDragOver = (e: DragEvent) => {
    e.preventDefault();
    setIsDragOver(true);
  };

  const handleDragLeave = (e: DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
  };

  const handleDrop = (e: DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
    // Snapshot synchronously — `dataTransfer.files` is bound to the drop
    // event and is no longer accessible after the handler returns.
    const files = e.dataTransfer?.files;
    if (!files || files.length === 0) return;
    onFilesSelected(Array.from(files));
  };

  return (
    <form
      onSubmit={onSubmit}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      className="relative px-4 pt-2 pb-3"
    >
      <div className="relative rounded-2xl border border-border bg-card shadow-md transition-colors focus-within:border-primary/40">
        {paletteOpen && (
          <CommandPalette
            commands={paletteCommands}
            selectedIndex={Math.min(paletteIndex, Math.max(0, paletteCommands.length - 1))}
            onPick={pickCommand}
            onHoverIndex={setPaletteIndex}
          />
        )}

        {/* File thumbnails row */}
        {pendingFiles.length > 0 && (
          <div className="flex gap-2 overflow-x-auto px-3 pt-3 pb-1" style={{ scrollbarWidth: "none" }}>
            {pendingFiles.map((file, i) => (
              <FileThumbnail
                key={`${file.name}-${file.size}-${i}`}
                file={file}
                onRemove={() => onRemoveFile(i)}
              />
            ))}
          </div>
        )}

        {/* Textarea */}
        <textarea
          ref={textareaRef}
          value={inputValue}
          onChange={(e) => {
            onInputChange(e.target.value);
            setCaretPos(e.target.selectionStart ?? 0);
            setPaletteIndex(0);
            // dismissed-reset lives in the inputValue effect so it also
            // covers programmatic clears (submit).
          }}
          onSelect={(e) =>
            setCaretPos((e.target as HTMLTextAreaElement).selectionStart ?? 0)
          }
          onKeyDown={handleKeyDown}
          placeholder={inSnapshotView ? "Switch to Draft to chat with the agent" : "Describe a scene..."}
          disabled={inSnapshotView || disabled}
          dir="auto"
          rows={1}
          className="w-full resize-none bg-transparent px-4 pt-3 pb-1 text-sm text-foreground placeholder-muted-foreground/50 outline-none disabled:cursor-not-allowed disabled:opacity-40"
          style={{ maxHeight: `${MAX_HEIGHT}px` }}
        />

        {/* Bottom bar: attach + clear | send */}
        <div className="flex items-center gap-2 px-2 pb-2">
          <div className="flex min-w-0 flex-1 items-center gap-1">
            <input
              ref={fileInputRef}
              type="file"
              multiple
              className="hidden"
              onChange={(e) => {
                // CRITICAL: snapshot `e.target.files` to a plain `File[]`
                // synchronously BEFORE clearing the input. Setting
                // `value = ""` empties the live FileList per the WHATWG
                // spec, so any deferred read (e.g. inside a React state
                // updater) would see zero files. This used to manifest as
                // "select a file → no thumbnail" right after creating a
                // new session, when ChatPanel's render churn delayed the
                // updater flush past the value clear.
                const selected = e.target.files;
                const snapshot = selected ? Array.from(selected) : [];
                e.target.value = "";
                if (snapshot.length > 0) onFilesSelected(snapshot);
              }}
            />
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={inSnapshotView || disabled}
              className="cursor-pointer rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-surface-hover hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
              title="Attach files"
            >
              <Plus className="h-5 w-5" />
            </button>
            {pendingFiles.length > 0 && (
              <button
                type="button"
                onClick={onClearFiles}
                className="cursor-pointer flex items-center gap-1 rounded-lg px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-surface-hover hover:text-foreground"
                title="Clear all files"
              >
                <X className="h-3 w-3" />
                <span>Clear all</span>
              </button>
            )}
          </div>
          <ContextUsageChip sessionId={sessionId} />
          <ModelPicker sessionId={sessionId} />
          <PermissionModePicker />
          {isStreaming ? (
            <button
              type="button"
              onClick={onCancel}
              aria-label="Stop"
              title="Stop"
              className="flex h-8 w-8 cursor-pointer items-center justify-center rounded-md bg-destructive text-destructive-foreground transition-colors hover:bg-destructive/80"
            >
              {/* Square stop glyph */}
              <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
                <rect x="3" y="3" width="10" height="10" rx="1.5" />
              </svg>
            </button>
          ) : (
            <button
              type="submit"
              disabled={inSnapshotView || !canSend}
              aria-label="Send message"
              title={inSnapshotView ? "Switch to Draft to chat with the agent" : "Send message"}
              className="flex h-8 w-8 cursor-pointer items-center justify-center rounded-full bg-primary text-primary-foreground transition-colors hover:bg-primary/80 disabled:cursor-not-allowed disabled:opacity-30"
            >
              <ArrowUp className="h-4 w-4" strokeWidth={2.5} />
            </button>
          )}
        </div>

        {/* Drag-and-drop overlay */}
        {isDragOver && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center rounded-2xl border-2 border-dashed border-primary bg-primary/10">
            <span className="text-sm font-medium text-primary">Drop files here</span>
          </div>
        )}
      </div>
    </form>
  );
}
