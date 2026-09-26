"use client";

import Link from "next/link";
import { Globe } from "lucide-react";
import { publishReviewHref, type PublishRequestCardPayload } from "@/lib/chat/publish-request";

/**
 * In the chat, after `libi.publish_template` prepared a publish: the agent
 * can't publish it, so the card takes the user to the one place that can —
 * the request's review panel on the Templates page.
 */
export function PublishRequestCard({ payload }: { payload: PublishRequestCardPayload }) {
  return (
    <div data-testid="publish-request-card" className="my-1.5 w-full max-w-[420px] rounded-lg border border-border bg-card p-3">
      <p className="flex items-center gap-2 text-sm font-medium">
        <Globe aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 truncate">Ready to publish {payload.name ? `“${payload.name}”` : "your template"}</span>
      </p>
      <p className="mt-1 text-xs text-muted-foreground">Nothing is public yet. Only you can publish it, after reviewing what becomes public.</p>
      <Link
        href={publishReviewHref(payload)}
        data-testid="publish-request-card-review"
        className="mt-3 inline-flex cursor-pointer items-center gap-2 rounded-md border border-border px-3 py-2 text-sm transition-colors hover:bg-accent"
      >
        Review and publish
      </Link>
    </div>
  );
}
