"use client";

import type * as React from "react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Copy, Send } from "lucide-react";
import { sendPromptToAgent } from "@/lib/agents/send-prompt-to-agent";

interface OverlayAgentDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialPrompt: string;
  sessionList: { switchSession: (id: string) => void; refresh: () => void };
  chatVisible: boolean;
  toggleChat: () => void;
}

/**
 * Editable ask-agent composer. Seeded with a scaffolded prompt (create or
 * modify), the user can edit it before sending to the in-app libi agent or
 * copying it for a bring-your-own CLI. Mirrors `DispatchToAgentDialog`'s chrome
 * but swaps the read-only `<pre>` for an editable `<textarea>`.
 */
export function OverlayAgentDialog({
  open,
  onOpenChange,
  initialPrompt,
  sessionList,
  chatVisible,
  toggleChat,
}: OverlayAgentDialogProps): React.JSX.Element {
  const [text, setText] = useState(initialPrompt);
  const [sending, setSending] = useState(false);

  // Re-seed the textarea whenever the dialog (re)opens with a new prompt.
  useEffect(() => {
    if (open) setText(initialPrompt);
  }, [initialPrompt, open]);

  const empty = text.trim().length === 0;

  const copy = () => {
    void navigator.clipboard.writeText(text);
    toast.success("Copied to clipboard");
  };

  const send = async () => {
    if (empty || sending) return;
    setSending(true);
    try {
      const r = await sendPromptToAgent(text, {
        onSession: (id) => {
          sessionList.switchSession(id);
          sessionList.refresh();
          if (!chatVisible) toggleChat();
        },
      });
      if (r.byoCli) {
        toast.info("No libi agent is running", {
          description:
            "You're in bring-your-own-CLI mode. Copy the prompt and paste it into your CLI.",
        });
      } else if (!r.ok) {
        toast.error("Couldn't send to the agent");
      } else {
        toast.success("Sent to the libi agent");
        onOpenChange(false);
      }
    } finally {
      setSending(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Ask the agent</DialogTitle>
          <DialogDescription>
            Edit the prompt, then send it to the libi agent or copy it to run in your own CLI.
          </DialogDescription>
        </DialogHeader>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={8}
          className="max-h-64 w-full resize-y overflow-auto rounded-md border bg-background p-3 text-xs text-foreground/90"
        />
        <DialogFooter className="gap-2 sm:justify-between">
          <Button variant="outline" className="cursor-pointer" onClick={copy}>
            <Copy className="mr-1.5 h-4 w-4" /> Copy to clipboard
          </Button>
          <Button className="cursor-pointer" onClick={send} disabled={empty || sending}>
            <Send className="mr-1.5 h-4 w-4" />
            {sending ? "Sending…" : "Send to libi agent"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
