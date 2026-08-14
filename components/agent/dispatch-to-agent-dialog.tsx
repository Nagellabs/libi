"use client";

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

type Props = {
  open: boolean;
  setOpen: (open: boolean) => void;
  prompt: string;
  send: () => void;
  copy: () => void;
  sending?: boolean;
  title?: string;
};

/**
 * Shared dual-mode dialog for handing a prompt to the agent. Shows the exact
 * prompt and offers [Copy to clipboard] (works everywhere, incl. BYO-CLI) and
 * [Send to libi agent] (uses the in-app ACP agent; in BYO-CLI mode the hook
 * shows a friendly toast instead of erroring). Pair with `useDispatchToAgent`.
 */
export function DispatchToAgentDialog({
  open,
  setOpen,
  prompt,
  send,
  copy,
  sending,
  title,
}: Props) {
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{title ?? "Send this to the agent"}</DialogTitle>
          <DialogDescription>
            Send it to the libi agent, or copy it to run in your own CLI.
          </DialogDescription>
        </DialogHeader>
        <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded-md border bg-muted/30 p-3 text-xs text-foreground/90">
          {prompt}
        </pre>
        <DialogFooter className="gap-2 sm:justify-between">
          <Button variant="outline" className="cursor-pointer" onClick={copy}>
            <Copy className="mr-1.5 h-4 w-4" /> Copy to clipboard
          </Button>
          <Button className="cursor-pointer" onClick={send} disabled={sending}>
            <Send className="mr-1.5 h-4 w-4" />
            {sending ? "Sending…" : "Send to libi agent"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
