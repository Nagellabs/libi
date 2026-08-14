"use client";

import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { useCreateMcpServer, useUpdateMcpServer } from "@/lib/queries/mcp-servers";
import type { McpServerUI } from "@/lib/queries/mcp-servers";

interface AddMcpDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** If provided, dialog is in edit mode */
  editServer?: McpServerUI | null;
}

export function AddMcpDialog({ open, onOpenChange, editServer }: AddMcpDialogProps) {
  const createMcp = useCreateMcpServer();
  const updateMcp = useUpdateMcpServer();

  // Lazy initializers seed from the server already being edited at mount; the
  // previous-state block below re-seeds when the dialog reopens or the edited
  // server changes (React's documented pattern — one pre-paint re-render, no
  // setState-in-effect cascade).
  const [name, setName] = useState(editServer?.name ?? "");
  const [type, setType] = useState<"stdio" | "http">(
    (editServer?.type as "stdio" | "http") ?? "stdio",
  );
  const [command, setCommand] = useState(editServer?.command ?? "");
  const [args, setArgs] = useState(() =>
    editServer?.args ? (JSON.parse(editServer.args) as string[]).join(" ") : "",
  );
  const [url, setUrl] = useState(editServer?.url ?? "");
  const [envVarsText, setEnvVarsText] = useState("");
  const [headersText, setHeadersText] = useState("");
  const [requireApproval, setRequireApproval] = useState(editServer?.requireApproval ?? true);

  const [prevSeed, setPrevSeed] = useState({ open, editServer });
  if (open !== prevSeed.open || editServer !== prevSeed.editServer) {
    setPrevSeed({ open, editServer });
    if (editServer) {
      setName(editServer.name);
      setType(editServer.type as "stdio" | "http");
      setCommand(editServer.command ?? "");
      setArgs(editServer.args ? JSON.parse(editServer.args).join(" ") : "");
      setUrl(editServer.url ?? "");
      // RC-F: the API never returns secret values — only the NAMES of
      // configured keys. Start the editor blank; already-set keys are surfaced
      // as a masked hint below. Typing a KEY=value adds/replaces it; existing
      // keys left untouched are preserved by the server-side merge.
      setEnvVarsText("");
      // RC-F: the API never returns header VALUES (bearer-token secrets) —
      // only the NAMES of configured headers. Start the editor blank;
      // already-set headers are surfaced as a masked hint below. Typing a
      // `Header: value` adds/replaces it; existing headers left untouched are
      // preserved by the server-side merge.
      setHeadersText("");
      setRequireApproval(editServer.requireApproval);
    } else {
      setName("");
      setType("stdio");
      setCommand("");
      setArgs("");
      setUrl("");
      setEnvVarsText("");
      setHeadersText("");
      setRequireApproval(true);
    }
  }

  function parseEnvVars(): Record<string, string> | undefined {
    if (!envVarsText.trim()) return undefined;
    const vars: Record<string, string> = {};
    for (const line of envVarsText.split("\n")) {
      const eqIdx = line.indexOf("=");
      if (eqIdx > 0) {
        vars[line.slice(0, eqIdx).trim()] = line.slice(eqIdx + 1).trim();
      }
    }
    return Object.keys(vars).length > 0 ? vars : undefined;
  }

  function parseHeaders(): Record<string, string> | undefined {
    if (!headersText.trim()) return undefined;
    const headers: Record<string, string> = {};
    for (const line of headersText.split("\n")) {
      const colonIdx = line.indexOf(":");
      if (colonIdx > 0) {
        headers[line.slice(0, colonIdx).trim()] = line.slice(colonIdx + 1).trim();
      }
    }
    return Object.keys(headers).length > 0 ? headers : undefined;
  }

  function handleSubmit() {
    const parsedArgs = args.trim() ? args.trim().split(/\s+/) : undefined;
    const envVars = parseEnvVars();

    if (editServer) {
      updateMcp.mutate(
        {
          id: editServer.id,
          name,
          type,
          command: type === "stdio" ? command : undefined,
          args: type === "stdio" ? parsedArgs : undefined,
          url: type === "http" ? url : undefined,
          headers: type === "http" ? parseHeaders() : undefined,
          envVars,
          requireApproval,
        },
        { onSuccess: () => onOpenChange(false) }
      );
    } else {
      createMcp.mutate(
        {
          name,
          type,
          command: type === "stdio" ? command : undefined,
          args: type === "stdio" ? parsedArgs : undefined,
          url: type === "http" ? url : undefined,
          headers: type === "http" ? parseHeaders() : undefined,
          envVars,
          requireApproval,
        },
        { onSuccess: () => onOpenChange(false) }
      );
    }
  }

  const isValid = name.trim() && (type === "stdio" ? command.trim() : url.trim());

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{editServer ? "Edit MCP Server" : "Add MCP Server"}</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="mcp-name">Name</Label>
            <Input id="mcp-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="My MCP Server" />
          </div>

          <div className="space-y-2">
            <Label>Type</Label>
            <div className="flex gap-2">
              <Button variant={type === "stdio" ? "default" : "outline"} size="sm" onClick={() => setType("stdio")}>
                stdio
              </Button>
              <Button variant={type === "http" ? "default" : "outline"} size="sm" onClick={() => setType("http")}>
                http
              </Button>
            </div>
          </div>

          {type === "stdio" ? (
            <>
              <div className="space-y-2">
                <Label htmlFor="mcp-command">Command</Label>
                <Input id="mcp-command" value={command} onChange={(e) => setCommand(e.target.value)} placeholder="npx" className="font-mono text-sm" />
              </div>
              <div className="space-y-2">
                <Label htmlFor="mcp-args">Arguments (space-separated)</Label>
                <Input id="mcp-args" value={args} onChange={(e) => setArgs(e.target.value)} placeholder="@some/mcp-server" className="font-mono text-sm" />
              </div>
            </>
          ) : (
            <>
              <div className="space-y-2">
                <Label htmlFor="mcp-url">URL</Label>
                <Input id="mcp-url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="http://localhost:8080/mcp" className="font-mono text-sm" />
              </div>
              <div className="space-y-2">
                <Label htmlFor="mcp-headers">Headers (one per line: Header-Name: value)</Label>
                {editServer && (editServer.configuredHeaders?.length ?? 0) > 0 && (
                  <p className="text-xs text-muted-foreground">
                    Set:{" "}
                    {editServer.configuredHeaders.map((k) => (
                      <span key={k} className="font-mono">
                        {k}: •••••••{" "}
                      </span>
                    ))}
                    <br />
                    Leave blank to keep existing values; type a Header: value to add or replace one.
                  </p>
                )}
                <textarea
                  id="mcp-headers"
                  value={headersText}
                  onChange={(e) => setHeadersText(e.target.value)}
                  placeholder={"Authorization: Bearer sk-...\nX-Custom: value"}
                  rows={3}
                  className="flex w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm font-mono shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                />
              </div>
            </>
          )}

          <div className="space-y-2">
            <Label htmlFor="mcp-env">Environment Variables (one per line: KEY=value)</Label>
            {editServer && (editServer.configuredEnvVars?.length ?? 0) > 0 && (
              <p className="text-xs text-muted-foreground">
                Set:{" "}
                {editServer.configuredEnvVars.map((k) => (
                  <span key={k} className="font-mono">
                    {k}=•••••••{" "}
                  </span>
                ))}
                <br />
                Leave blank to keep existing values; type a KEY=value to add or replace one.
              </p>
            )}
            <textarea
              id="mcp-env"
              value={envVarsText}
              onChange={(e) => setEnvVarsText(e.target.value)}
              placeholder={"API_KEY=sk-...\nOTHER_VAR=value"}
              rows={3}
              className="flex w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm font-mono shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            />
          </div>

          <div className="flex items-center gap-2">
            <Switch id="mcp-approval" checked={requireApproval} onCheckedChange={setRequireApproval} />
            <Label htmlFor="mcp-approval">Require approval before use</Label>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={handleSubmit} disabled={!isValid}>
            {editServer ? "Save" : "Add"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
