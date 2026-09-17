"use client";

import { useRef, useState } from "react";
import { ImagePlus, X } from "lucide-react";
import * as Sentry from "@sentry/nextjs";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { trackEvent } from "@/lib/analytics/client";

interface FeedbackDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * Fired once, synchronously, right after `captureFeedback` resolves and
   * right before the dialog closes itself. This is the ONLY success signal —
   * cancelling, Escape, a backdrop click, and a failed send never call it.
   * Lets a trigger (FeedbackSection's success tick) react to a real send
   * without lifting this dialog's message/file/error state up to hold it.
   */
  onSubmitted?: () => void;
}

// Images only, and these three caps. Named constants so the numbers are typed
// once, not re-typed (and drifted) at the call site.
//
// WHY THESE NUMBERS. The SDK enforces NO size limit client-side — there is no
// attachment-size constant anywhere in `@sentry/core`. The limits are
// server-side, so an oversized attachment is dropped SILENTLY: the message
// still arrives, just without the file the user attached. That silent-loss
// mode is the whole reason to cap here, where the user can be told before
// they send.
/** Most images a single send can carry. */
const MAX_FILES = 5;
/** Per-file cap, deliberately just under Sentry's own 20 MB per-attachment limit. */
const MAX_FILE_BYTES = 19.9 * 1024 * 1024;
/**
 * Cap across ALL picked files, not just each one individually. Sentry's
 * envelope limit is 100 MB, and 5 files at the per-file cap would sit right on
 * top of it once the event body and multipart overhead are added.
 */
const MAX_TOTAL_BYTES = 50 * 1024 * 1024;

function formatMB(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Native libi replacement for Sentry's own feedback widget. Sends through
 * `Sentry.captureFeedback` directly, with user-picked image files attached —
 * see `lib/sentry/gated-transport.ts#containsFeedback` and
 * `lib/sentry/scrub.ts#scrubFeedback` for the (unmodified) send path this
 * feeds into.
 *
 * Attachments are never scrubbed, and cannot be — they are binary. Picking one
 * is the user's deliberate consent to send it.
 */
export function FeedbackDialog({ open, onOpenChange, onSubmitted }: FeedbackDialogProps) {
  const [message, setMessage] = useState("");
  const [email, setEmail] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  function handleFilesPicked(picked: File[]) {
    if (picked.length === 0) return;

    let total = files.reduce((sum, f) => sum + f.size, 0);
    const accepted: File[] = [];
    // Only the FIRST offending file is reported: once one is rejected, the
    // caps that would apply to the rest are no longer meaningful (the count
    // is already full, or the total already over), so there is nothing
    // truthful left to say about the remainder of this pick.
    let rejection: string | null = null;

    for (const file of picked) {
      if (files.length + accepted.length >= MAX_FILES) {
        rejection = `Only ${MAX_FILES} images can be attached at once — "${file.name}" was not added.`;
        break;
      }
      if (file.size > MAX_FILE_BYTES) {
        rejection = `"${file.name}" is over the ${formatMB(MAX_FILE_BYTES)} per-file limit and was not added.`;
        break;
      }
      if (total + file.size > MAX_TOTAL_BYTES) {
        rejection = `Adding "${file.name}" would push the total past ${formatMB(MAX_TOTAL_BYTES)} and was not added.`;
        break;
      }
      accepted.push(file);
      total += file.size;
    }

    if (accepted.length > 0) setFiles((prev) => [...prev, ...accepted]);
    // Naming the offending file and the limit it hit — never a silent drop.
    // Silent dropping is precisely what the server does, and precisely what
    // this cap exists to prevent.
    setError(rejection);
  }

  function removeFile(index: number) {
    setFiles((prev) => prev.filter((_, i) => i !== index));
  }

  function isFileDrag(e: React.DragEvent): boolean {
    const types = e.dataTransfer?.types;
    return Boolean(types && Array.from(types).includes("Files"));
  }

  function handleDragOver(e: React.DragEvent<HTMLDivElement>) {
    if (!isFileDrag(e)) return;
    // Required for the browser to treat this as a valid drop target at all —
    // without it, `onDrop` never fires and the cursor shows "not allowed".
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    if (!dragActive) setDragActive(true);
  }

  /**
   * Chromium fires `dragleave` with `relatedTarget === null` while the
   * pointer is still mid-drag INSIDE the page — not just at the window edge.
   * A `!e.relatedTarget` check therefore reads as "left" on an ordinary
   * drag over the dialog's own children and the ring flickers off and back
   * ~60x/sec. This repo already shipped that exact bug once, in
   * components/preview/timeline.tsx — see its handleDragLeave for the
   * measured repro. Only a dragleave that NAMES the element the pointer
   * moved to, and that element is outside the panel, means "actually left".
   * `handleDrop` below is what reliably clears the ring on a real drop.
   */
  function handleDragLeave(e: React.DragEvent<HTMLDivElement>) {
    const to = e.relatedTarget as Node | null;
    if (to && !e.currentTarget.contains(to)) setDragActive(false);
  }

  function handleDrop(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setDragActive(false);
    const dropped = Array.from(e.dataTransfer.files ?? []);
    if (dropped.length === 0) return;

    const images = dropped.filter((f) => f.type.startsWith("image/"));
    if (images.length === 0) {
      // A drop of, say, a PDF or a folder should say so — not silently do
      // nothing, which reads as the drop having failed for no reason.
      setError("Only image files can be attached — that drop had none.");
      return;
    }
    // Same cap/message logic as the "Attach images" picker — see
    // handleFilesPicked above. Never re-implement the caps here.
    handleFilesPicked(images);
  }

  /**
   * Routes every way the dialog can CLOSE — Cancel, Escape, a backdrop click —
   * through one reset, so a stale error (or a half-finished draft from a
   * message the user abandoned) never bleeds into the next time they open it.
   * The one path that does NOT go through here is a successful send, which
   * resets inline in `handleSubmit` right before its own `onOpenChange(false)`
   * — same effect, just already holding the values it needs to clear.
   */
  function handleOpenChange(next: boolean) {
    if (!next) {
      setMessage("");
      setEmail("");
      setFiles([]);
      setError(null);
      setDragActive(false);
    }
    onOpenChange(next);
  }

  async function handleSubmit() {
    if (!message.trim() || sending) return;
    setSending(true);
    setError(null);
    try {
      const attachments = await Promise.all(
        files.map(async (file) => ({
          filename: file.name,
          data: new Uint8Array(await file.arrayBuffer()),
          contentType: file.type || undefined,
        })),
      );

      await Sentry.captureFeedback(
        { message, email: email.trim() || undefined, source: "settings" },
        { attachments },
      );

      // Booleans only — analytics params are bounded-cardinality by rule, and
      // the message/address go to Sentry and nowhere else.
      trackEvent("feedback_submitted", {
        with_email: Boolean(email.trim()),
        with_screenshot: attachments.length > 0,
      });

      toast.success("Thank you — we've got it.");
      setMessage("");
      setEmail("");
      setFiles([]);
      onSubmitted?.();
      onOpenChange(false);
    } catch {
      // Keep the dialog open and the user's text intact. A form that silently
      // eats what someone typed on a network blip is worse than no form.
      setError("Something went wrong sending your feedback. Please try again.");
    } finally {
      setSending(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        className="sm:max-w-md"
        data-testid="feedback-dialog-panel"
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        {/* Whole-panel drop target: an accent ring + tint while a file drag is
            over ANY part of the dialog, not just the attachment row. Purely
            visual — `pointer-events-none` so it never steals the drag/drop
            events it's reacting to, which are read on DialogContent itself. */}
        {dragActive && (
          <div
            data-testid="feedback-dialog-drag-overlay"
            className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-xl bg-primary/10 ring-2 ring-primary"
          >
            <span className="rounded-md bg-popover px-3 py-1.5 text-sm font-medium text-primary shadow-sm">
              Drop images to attach
            </span>
          </div>
        )}

        <DialogHeader>
          <DialogTitle>Send feedback</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="feedback-message">What happened?</Label>
            <textarea
              id="feedback-message"
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder="Tell us what went wrong, or what would work better."
              rows={5}
              className="flex w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="feedback-email">Email (optional)</Label>
            <Input
              id="feedback-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="name@example.com"
            />
          </div>

          <div className="space-y-2">
            <Label>Images (optional)</Label>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              multiple
              className="hidden"
              onChange={(e) => {
                // Snapshot before clearing — a live FileList empties the
                // instant `value` resets (WHATWG spec), so a deferred read
                // (inside a React state updater) would otherwise see zero
                // files. Clearing lets the same file be re-picked.
                const selected = e.target.files;
                const snapshot = selected ? Array.from(selected) : [];
                e.target.value = "";
                handleFilesPicked(snapshot);
              }}
            />
            <div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="cursor-pointer"
                onClick={() => fileInputRef.current?.click()}
                disabled={files.length >= MAX_FILES}
              >
                <ImagePlus className="mr-1.5 size-4" />
                Attach images
              </Button>
            </div>

            {files.length > 0 && (
              <ul className="space-y-1">
                {files.map((file, i) => (
                  <li
                    key={`${file.name}-${i}`}
                    className="flex items-center justify-between gap-2 rounded-md border border-input px-2.5 py-1.5 text-xs"
                  >
                    <span className="truncate">
                      {file.name} · {formatMB(file.size)}
                    </span>
                    <button
                      type="button"
                      onClick={() => removeFile(i)}
                      className="cursor-pointer text-muted-foreground hover:text-foreground"
                      aria-label={`Remove ${file.name}`}
                    >
                      <X className="size-3.5" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            className="cursor-pointer"
            onClick={() => handleOpenChange(false)}
            disabled={sending}
          >
            Cancel
          </Button>
          <Button
            className="cursor-pointer"
            onClick={handleSubmit}
            disabled={!message.trim() || sending}
          >
            Send feedback
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
