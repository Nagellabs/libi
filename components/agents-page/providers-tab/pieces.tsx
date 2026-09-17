"use client";

import { useEffect, useRef, useState } from "react";
import { Check, Copy, ExternalLink } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { useLegacyKeyNotices, useAcknowledgeLegacyKey } from "@/lib/queries/providers";

/** The small presentational pieces the Providers tab's rows are built from. */

type Agent = "claude" | "codex";

/** The copy box. Read-only by construction — there is no input here, ever. */
export function CommandBox({ id, command }: { id: string; command: string }) {
  const [copied, setCopied] = useState(false);
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (resetTimer.current) clearTimeout(resetTimer.current);
    },
    [],
  );
  return (
    <div className="flex items-start gap-2 rounded-md border border-border bg-muted/40 p-2">
      {/* pre-wrap + break-all: the placeholder sits at the END of every
          key-bearing command, and a horizontally scrolling box hid exactly
          that part. */}
      <code
        data-testid={`command-${id}`}
        className="flex-1 whitespace-pre-wrap break-all font-mono text-[11px] leading-relaxed"
      >
        {command}
      </code>
      <Button
        size="icon-xs"
        variant="ghost"
        className="cursor-pointer shrink-0"
        aria-label="Copy command"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(command);
            setCopied(true);
            if (resetTimer.current) clearTimeout(resetTimer.current);
            resetTimer.current = setTimeout(() => setCopied(false), 1500);
          } catch {
            toast.error("Couldn't copy — select the command and copy it by hand.");
          }
        }}
      >
        {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
      </Button>
    </div>
  );
}

/**
 * The one-time notice for a key libi used to hold. The user gave
 * libi this key before libi stopped taking keys; handing it back inside the
 * add command for their agent is strictly better than dropping it silently.
 * "I've copied it" deletes the value — the notice is gone for good after
 * that, and so is the key from libi's side. This is the ONLY place a stored
 * secret is ever rendered, and it renders exactly once per key.
 */
export function LegacyKeyNotice({ agent, enabled }: { agent: Agent; enabled: boolean }) {
  const { data } = useLegacyKeyNotices({ enabled });
  const ack = useAcknowledgeLegacyKey();
  const notices = data?.notices ?? [];
  if (notices.length === 0) return null;

  return (
    <section className="space-y-2" data-testid="legacy-key-notices">
      {notices.map((n) => (
        <div
          key={n.rowId}
          data-testid={`legacy-key-${n.rowId}`}
          className="space-y-2 rounded-lg border border-amber-500/40 bg-amber-500/5 p-3"
        >
          <p className="text-xs">
            <strong>{n.providerName} is no longer bundled.</strong> libi no longer stores API
            keys. Here is the key you gave it, inside the command that connects {n.providerName}{" "}
            to your own agent — copy it, run it, and libi forgets the key.
          </p>
          <CommandBox id={`legacy-${n.rowId}`} command={n.commands[agent]} />
          <Button
            size="sm"
            className="cursor-pointer"
            disabled={ack.isPending}
            onClick={() => {
              void ack.mutateAsync(n.rowId).catch(() => {
                toast.error("Couldn't clear the key — try again.");
              });
            }}
          >
            I&apos;ve copied it
          </Button>
        </div>
      ))}
    </section>
  );
}

export function DocsLink({ href }: { href: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="inline-flex h-7 cursor-pointer items-center gap-1 rounded-[min(var(--radius-md),12px)] px-2.5 text-[0.8rem] font-medium text-muted-foreground hover:bg-muted hover:text-foreground"
    >
      <ExternalLink className="size-3.5" />
      Docs
    </a>
  );
}
