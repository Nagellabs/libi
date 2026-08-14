"use client";

import { useState } from "react";
import { Eye, EyeOff } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useUpdateMcpServer } from "@/lib/queries/mcp-servers";
import type { McpServerUI } from "@/lib/queries/mcp-servers";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  server: McpServerUI;
  /** Names of env vars the server requires. */
  requiredEnvVars: string[];
}

export function McpEnvVarsDialog({ open, onOpenChange, server, requiredEnvVars }: Props) {
  const update = useUpdateMcpServer();

  // RC-F: the API never returns secret values, only the NAMES of configured
  // keys. We start every field blank; a masked placeholder shows which keys
  // are already set. Leaving a field blank means "leave the stored key
  // unchanged" (the server merges only typed values).
  const configured = new Set(server.configuredEnvVars ?? []);

  const [values, setValues] = useState<Record<string, string>>({});
  const [shown, setShown] = useState<Record<string, boolean>>({});

  // Blank the fields each time the dialog opens (or the server changes while
  // open). Adjusted during render — same reset, no setState-in-effect cascade.
  const resetKey = open ? server.id : null;
  const [prevResetKey, setPrevResetKey] = useState(resetKey);
  if (resetKey !== prevResetKey) {
    setPrevResetKey(resetKey);
    if (open) {
      setValues({});
      setShown({});
    }
  }

  // A required key is satisfied when it's already configured OR the user typed a value.
  const allRequiredFilled = requiredEnvVars.every(
    (k) => configured.has(k) || (values[k] ?? "").trim().length > 0,
  );

  function handleSave() {
    // Only send keys the user actually typed. Blank fields are omitted so a
    // stored secret is never overwritten with an empty value.
    const cleaned: Record<string, string> = {};
    for (const [k, v] of Object.entries(values)) {
      if ((v ?? "").trim().length > 0) cleaned[k] = v;
    }
    update.mutate(
      { id: server.id, envVars: cleaned },
      {
        onSuccess: () => onOpenChange(false),
      },
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Configure {server.name}</DialogTitle>
          <DialogDescription>
            Set the API key{requiredEnvVars.length === 1 ? "" : "s"} required for {server.name}. Stored locally in your Libi database.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 py-2">
          {requiredEnvVars.map((key) => (
            <div key={key} className="space-y-1.5">
              <Label htmlFor={`env-${key}`} className="text-xs font-mono">
                {key}
                {configured.has(key) ? (
                  <span className="ml-1 text-muted-foreground">(set — leave blank to keep)</span>
                ) : (
                  <span className="ml-1 text-muted-foreground">(required)</span>
                )}
              </Label>
              <div className="relative">
                <Input
                  id={`env-${key}`}
                  type={shown[key] ? "text" : "password"}
                  value={values[key] ?? ""}
                  onChange={(e) => setValues((v) => ({ ...v, [key]: e.target.value }))}
                  placeholder={configured.has(key) ? "••••••••" : `Enter ${key}…`}
                  className="pr-10 font-mono text-sm"
                  autoComplete="off"
                />
                <button
                  type="button"
                  onClick={() => setShown((s) => ({ ...s, [key]: !s[key] }))}
                  className="absolute right-2 top-1/2 -translate-y-1/2 cursor-pointer text-muted-foreground hover:text-foreground"
                  aria-label={shown[key] ? "Hide value" : "Show value"}
                >
                  {shown[key] ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                </button>
              </div>
            </div>
          ))}
        </div>

        {update.error && (
          <p className="text-xs text-red-500">{(update.error as Error).message}</p>
        )}

        <DialogFooter>
          <Button
            variant="outline"
            className="cursor-pointer"
            onClick={() => onOpenChange(false)}
            disabled={update.isPending}
          >
            Cancel
          </Button>
          <Button
            className="cursor-pointer"
            onClick={handleSave}
            disabled={!allRequiredFilled || update.isPending}
          >
            {update.isPending ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
