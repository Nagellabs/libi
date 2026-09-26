"use client";

import { useState } from "react";
import { BusyLabel } from "@/components/agents-page/agents-tab/steps/busy-label";
import { Button } from "@/components/ui/button";
import { NicknameEditor } from "@/components/templates/nickname-editor";
import { CreatorStatusLine } from "@/components/templates/templates-page/creator-status";
import { useDiscardPendingPublish, usePendingPublishes } from "@/lib/queries/templates-cloud";
import type { PendingPublish, PendingPublishState } from "@/lib/templates/types";

/** What each pending state means to the user. `reserved` is not a problem — nothing is running. */
const STATE_COPY: Record<PendingPublishState, string> = {
  publishing: "Publishing now.",
  unfinished: "A publish stopped part-way. The next publish of this template finishes that same publish.",
  "needs-attention": "libi stopped retrying this publish.",
  reserved: "Nothing in flight. Its catalog id is reserved for your next publish of it.",
  unreadable: "libi can't read this publish's record.",
  "other-catalog": "Started against another catalog than the one this libi is using.",
};

/**
 * What discarding gives up, said before it happens. The route refuses any
 * discard that could let the next publish make a second public copy.
 */
function discardWarning(p: PendingPublish): string {
  if (p.state === "reserved") return "Discard it? The next publish of this template gets a new catalog id.";
  if (p.state === "unfinished") {
    return "Discard it? libi checks the catalog first: if this publish may have gone live, it keeps it instead, and the next publish of this template finishes it.";
  }
  return "Discard it? libi forgets this publish; the next publish of this template starts over.";
}

function PendingRow({ p }: { p: PendingPublish }) {
  const discard = useDiscardPendingPublish();
  const [confirming, setConfirming] = useState(false);
  const busy = p.state === "publishing";
  // The route's refusal (it could make a second public copy), shown where the user clicked.
  const refusal = discard.error?.message ?? null;
  return (
    <li data-testid={`pending-publish-${p.templateId}`} data-state={p.state} className="text-xs">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="font-medium text-foreground">{p.name}</span>
        <span className="text-muted-foreground">{STATE_COPY[p.state]}</span>
        {busy ? (
          <span className="text-muted-foreground">Stop the publish first to discard it.</span>
        ) : !confirming ? (
          <Button
            variant="ghost"
            size="xs"
            className="cursor-pointer"
            disabled={discard.isPending}
            onClick={() => {
              discard.reset();
              setConfirming(true);
            }}
          >
            Discard the pending publish
          </Button>
        ) : null}
      </div>
      {refusal && !confirming ? (
        <p data-testid={`pending-publish-error-${p.templateId}`} className="mt-0.5 text-destructive">
          {refusal}
        </p>
      ) : null}
      {p.state === "needs-attention" && p.detail ? <p className="mt-0.5 text-muted-foreground">Why: {p.detail}.</p> : null}
      {p.state === "other-catalog" && p.detail ? <p className="mt-0.5 text-muted-foreground">{p.detail}</p> : null}
      {confirming ? (
        <div className="mt-1 flex flex-wrap items-center gap-2">
          <span className="text-muted-foreground">{discardWarning(p)}</span>
          <Button
            variant="destructive"
            size="xs"
            className="cursor-pointer"
            data-testid={`pending-publish-discard-${p.templateId}`}
            disabled={discard.isPending}
            onClick={() => discard.mutate(p.templateId, { onSettled: () => setConfirming(false) })}
          >
            {discard.isPending ? <BusyLabel>Discarding…</BusyLabel> : "Discard"}
          </Button>
          <Button variant="ghost" size="xs" className="cursor-pointer" disabled={discard.isPending} onClick={() => setConfirming(false)}>
            Keep it
          </Button>
        </div>
      ) : null}
    </li>
  );
}

/**
 * Templates page header: "Publishing as <nickname>", edited inline
 * (`NicknameEditor` — every creator has a random default until they rename it
 * there or in Settings → General); under it, the creator's approval to
 * publish (invite-only — `CreatorStatusLine`, with "Apply to publish");
 * below that, any publish that has not landed,
 * each with "Discard the pending publish" (a publish job's error points here).
 */
export function PublishingAs() {
  const pending = usePendingPublishes();

  return (
    <div data-testid="publishing-as" className="flex flex-col items-end gap-1 text-sm">
      <NicknameEditor label="Publishing as" />
      <CreatorStatusLine />
      {pending.data && pending.data.length > 0 ? (
        <ul data-testid="pending-publishes" className="max-w-md space-y-1 rounded-md border border-border bg-card px-3 py-2">
          {pending.data.map((p) => (
            <PendingRow key={p.templateId} p={p} />
          ))}
        </ul>
      ) : null}
    </div>
  );
}
