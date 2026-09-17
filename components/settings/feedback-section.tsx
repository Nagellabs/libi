"use client";

import { useState } from "react";
import { Check, MessageSquare } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SENTRY_ENABLED } from "@/lib/sentry/config";
import { FeedbackDialog } from "@/components/settings/feedback-dialog";

/**
 * "Send feedback" in Settings → General, directly below the version lines.
 *
 * Opens libi's own `FeedbackDialog` — a native dialog, not Sentry's widget.
 * That widget rendered in a shadow root, which needed a whole layer of
 * CSS-variable and injected-stylesheet coupling to Sentry's private class
 * names just to look like libi (see the git history for
 * lib/sentry/feedback-options.ts / feedback-shadow-styles.ts, both deleted
 * alongside this change). Its screen-capture control also never worked in the
 * Electron shell — `getDisplayMedia` rejects with `NotSupportedError` there,
 * measured 2026-09-06 — while a plain file picker has no such dependency.
 *
 * RENDERS NOTHING when Sentry cannot send (a contributor clone, or the
 * kill switch). A form that would silently discard what the user typed is
 * worse than no form at all.
 *
 * Feedback still sends when the user has switched OFF "Send crash reports" —
 * see lib/sentry/gated-transport.ts. That is deliberate: they composed this
 * message and pressed Send.
 */
export function FeedbackSection() {
  const [open, setOpen] = useState(false);
  // Success tick, shown on the button in place of MessageSquare after a send
  // actually goes through (see FeedbackDialog's `onSubmitted`). Deliberately
  // local to this section, not lifted to a parent: unmounting the section
  // (navigating away from Settings → General) is meant to reset it for free,
  // and cleared explicitly the moment the dialog is reopened, below.
  const [sent, setSent] = useState(false);

  if (!SENTRY_ENABLED) return null;

  return (
    <div>
      <h3 className="text-sm font-semibold text-foreground">Send feedback</h3>
      <p className="mt-1 text-sm text-muted-foreground">
        Found a bug, or something that should work differently? Your feedback
        matters to us — we read every message. Add your email if you&apos;d like
        a reply.
      </p>

      <div className="mt-4">
        <Button
          variant="outline"
          className="cursor-pointer"
          onClick={() => {
            setSent(false);
            setOpen(true);
          }}
        >
          {sent ? <Check className="mr-2 size-4" /> : <MessageSquare className="mr-2 size-4" />}
          Send feedback
        </Button>
      </div>

      <FeedbackDialog open={open} onOpenChange={setOpen} onSubmitted={() => setSent(true)} />
    </div>
  );
}
