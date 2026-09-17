"use client";

import { Copy } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";

/** Registers libi with a CLI the user runs outside libi, in the folder they run it in. */
const CONNECT_COMMAND = "npx @nagellabs/libi connect";

export function SmallPrint() {
  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(CONNECT_COMMAND);
      toast.success("Copied");
    } catch {
      toast.error("Couldn't copy — select the command and copy it by hand.");
    }
  };

  return (
    <div className="flex flex-wrap items-center gap-2 border-t border-border pt-4">
      <p className="min-w-0 flex-1 text-xs text-muted-foreground">
        In a terminal,{" "}
        <code className="rounded bg-muted px-1 py-0.5 font-mono text-[11px] text-foreground">{CONNECT_COMMAND}</code>{" "}
        in a folder does the same: libi&#39;s tools for your whole account, and libi&#39;s skills for that folder.
      </p>
      <Button
        variant="ghost"
        size="sm"
        className="shrink-0 cursor-pointer text-muted-foreground"
        onClick={() => void handleCopy()}
      >
        <Copy className="size-3.5" />
        Copy
      </Button>
    </div>
  );
}
