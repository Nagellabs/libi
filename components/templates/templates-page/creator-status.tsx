"use client";

import { useState, type FormEvent } from "react";
import { BadgeCheck, Clock } from "lucide-react";
import { toast } from "sonner";
import { BUSY_BUTTON_CLASS, BusyLabel } from "@/components/agents-page/agents-tab/steps/busy-label";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { useLegalLinks } from "@/lib/queries/templates-catalog";
import { useApplyAsCreator, useCreatorStatus } from "@/lib/queries/templates-cloud";
import { CREATOR_NOTE_MAX, INVITE_ONLY } from "@/lib/templates/cloud/constants";
import { OpensOutside } from "@/components/templates/templates-page/opens-outside";

/**
 * Publishing to the public catalog is invite-only: a creator applies here, the
 * owner reviews applications by hand, and only an approved creator key
 * publishes (lib/templates/cloud/creator.ts). Local templates are untouched.
 */
export const CREATOR_COPY = {
  none: INVITE_ONLY,
  apply: "Apply to publish",
  pending: "Application received — we'll review it",
  approved: "Approved creator",
  rejected: "Not approved for publishing",
} as const;

/**
 * The point-of-collection notice, kept in view beside Submit (the pattern of
 * components/premium/waitlist-card.tsx). It must say what the Privacy Policy
 * says about creator applications (libi-site lib/legal-content.ts): change
 * both together.
 */
export const APPLY_NOTICE =
  "We send your email, your note, your public nickname and your creator id to the libi catalog so we can review your application and reply. We keep it until we decide, for as long as you're an approved creator, and for 12 months after we decline it or withdraw approval. Ask admin@nagellabs.com to delete it any time. See the";

/** A pragmatic check before sending; the site validates again. */
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** "Apply to publish": email, an optional note, the privacy notice, Submit. */
export function ApplyToPublishDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const apply = useApplyAsCreator();
  const links = useLegalLinks();
  const [email, setEmail] = useState("");
  const [note, setNote] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const sending = apply.isPending;
  // libi's own check first; otherwise the route's refusal (libi's words), shown here.
  const error = problem ?? apply.error?.message ?? null;

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (sending) return;
    const address = email.trim();
    if (address.length > 254 || !EMAIL.test(address)) {
      setProblem("That doesn't look like a valid email.");
      return;
    }
    setProblem(null);
    apply.mutate(
      { email: address, note: note.trim() },
      {
        onSuccess: () => {
          onOpenChange(false);
          setEmail("");
          setNote("");
          toast.success("Application sent — we'll review it.");
        },
      },
    );
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (next) {
          apply.reset();
          setProblem(null);
        }
        onOpenChange(next);
      }}
    >
      <DialogContent className="sm:max-w-md" data-testid="creator-apply-dialog">
        <form noValidate onSubmit={onSubmit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>Apply to publish</DialogTitle>
            <DialogDescription>
              {INVITE_ONLY} Tell us where to reach you — we review applications by hand.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="creator-apply-email">Email</Label>
            <Input
              id="creator-apply-email"
              type="email"
              required
              aria-label="Email"
              placeholder="you@example.com"
              autoComplete="email"
              value={email}
              disabled={sending}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="creator-apply-note">What would you publish? (optional)</Label>
            <textarea
              id="creator-apply-note"
              aria-label="What would you publish? (optional)"
              rows={3}
              maxLength={CREATOR_NOTE_MAX}
              value={note}
              disabled={sending}
              onChange={(e) => setNote(e.target.value)}
              className="flex w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50"
            />
            <p className="text-right text-xs text-muted-foreground">
              {note.length}/{CREATOR_NOTE_MAX}
            </p>
          </div>
          {/* The notice stays visible whether or not there is an error: it is the disclosure the application rests on. */}
          <p className="text-xs leading-relaxed text-muted-foreground">
            {APPLY_NOTICE}{" "}
            <a href={links.privacy} target="_blank" rel="noreferrer" className="cursor-pointer underline underline-offset-2 hover:text-foreground">
              Privacy Policy
              <OpensOutside />
            </a>
            .
          </p>
          {error ? (
            <p role="alert" data-testid="creator-apply-error" className="text-xs text-destructive">
              {error}
            </p>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="outline" className="cursor-pointer" disabled={sending} onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button
              type="submit"
              data-testid="creator-apply-submit"
              className={`cursor-pointer ${BUSY_BUTTON_CLASS}`}
              disabled={sending}
              focusableWhenDisabled={sending}
            >
              {sending ? <BusyLabel>Sending…</BusyLabel> : "Submit"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Under "Publishing as": this install's approval to publish. Nothing when the
 * catalog can't be reached — the status is unknown, and the site stays the gate.
 */
export function CreatorStatusLine() {
  const q = useCreatorStatus();
  const [applying, setApplying] = useState(false);
  if (q.isPending) return <Skeleton data-testid="creator-status-skeleton" className="h-4 w-48" />;
  const status = q.data?.status ?? null;
  if (status === null) return null;
  return (
    <div data-testid="creator-status" data-status={status} className="flex items-center justify-end gap-1.5 text-right text-xs text-muted-foreground">
      {status === "none" ? (
        <>
          <span>{CREATOR_COPY.none}</span>
          <Button variant="link" size="xs" data-testid="creator-apply" className="cursor-pointer px-0" onClick={() => setApplying(true)}>
            {CREATOR_COPY.apply}
          </Button>
          <ApplyToPublishDialog open={applying} onOpenChange={setApplying} />
        </>
      ) : status === "pending" ? (
        <span className="inline-flex items-center gap-1">
          <Clock aria-hidden className="size-3" />
          {CREATOR_COPY.pending}
        </span>
      ) : status === "approved" ? (
        <Badge variant="secondary" className="gap-1">
          <BadgeCheck aria-hidden className="size-3" />
          {CREATOR_COPY.approved}
        </Badge>
      ) : (
        <span>{CREATOR_COPY.rejected}</span>
      )}
    </div>
  );
}

const GATE_COPY = {
  none: INVITE_ONLY,
  pending: "Your application is waiting for review — you can publish once you're approved.",
  rejected: "This creator key isn't approved for publishing.",
} as const;

/** The review panel's stand-in for Publish while this install isn't an approved creator. */
export function CreatorGatePrompt({ status }: { status: "none" | "pending" | "rejected" }) {
  const [applying, setApplying] = useState(false);
  return (
    <div data-testid="publish-review-creator-gate" data-status={status} className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
      <span>{GATE_COPY[status]}</span>
      {status === "none" ? (
        <>
          <Button data-testid="publish-review-apply" className="cursor-pointer" onClick={() => setApplying(true)}>
            {CREATOR_COPY.apply}
          </Button>
          <ApplyToPublishDialog open={applying} onOpenChange={setApplying} />
        </>
      ) : null}
    </div>
  );
}
