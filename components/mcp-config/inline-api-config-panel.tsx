"use client";

import { useState } from "react";
import { useMcpServers, useUpdateMcpServer } from "@/lib/queries/mcp-servers";
import { useEditorState } from "@/lib/editor-state-context";
import { BUNDLED_MCP_SERVERS } from "@/mcp/registry/bundled";

export function InlineApiConfigPanel({ mcpId }: { mcpId: string | null }) {
  const { setRightRegionMode, setApiConfigMcpId } = useEditorState();
  const { data: servers } = useMcpServers();
  const update = useUpdateMcpServer();
  const [values, setValues] = useState<Record<string, string>>({});

  const server = servers?.find((s) => s.id === mcpId);

  // Required env-var names come from the bundled def (client-safe: bundled.ts is
  // already imported by components/settings/mcp-server-card.tsx). The DB row
  // does not carry requiredEnvVars — that lives on the static definition only.
  const bundledDef = BUNDLED_MCP_SERVERS.find((d) => d.id === mcpId);
  const required: string[] = bundledDef?.requiredEnvVars ?? [];

  function close() {
    setApiConfigMcpId(null);
    setRightRegionMode("editor");
  }

  async function save() {
    if (!mcpId) return;
    // Strip blank values so the row stays clean (same policy as McpEnvVarsDialog).
    const cleaned: Record<string, string> = {};
    for (const [k, v] of Object.entries(values)) {
      if ((v ?? "").trim().length > 0) cleaned[k] = v;
    }
    await update.mutateAsync({ id: mcpId, envVars: cleaned });
    close();
  }

  // Disable Save when any required field is empty.
  const allRequiredFilled = required.every((k) => (values[k] ?? "").trim().length > 0);

  return (
    <div className="flex h-full flex-col gap-6 overflow-y-auto p-8">
      <div className="flex items-start justify-between">
        <div>
          <h2 className="text-2xl font-medium">
            Configure {server?.name ?? mcpId}
          </h2>
          <p className="mt-1 text-muted-foreground">
            The agent needs an API key to continue.
          </p>
        </div>
        <button
          aria-label="Close"
          className="cursor-pointer rounded-md px-2 py-1 hover:bg-accent"
          onClick={close}
        >
          ✕
        </button>
      </div>

      <div className="flex flex-col gap-3">
        {(required.length > 0 ? required : ["API_KEY"]).map((envVar) => (
          <label key={envVar} className="flex flex-col gap-1">
            <span className="text-sm text-muted-foreground font-mono">
              {envVar}
              <span className="ml-1 text-xs">(required)</span>
            </span>
            <input
              type="password"
              autoComplete="off"
              className="cursor-text rounded-lg border border-border bg-background px-3 py-2 text-sm font-mono outline-none focus:ring-1 focus:ring-ring"
              value={values[envVar] ?? ""}
              onChange={(e) =>
                setValues((v) => ({ ...v, [envVar]: e.target.value }))
              }
              placeholder={`Enter ${envVar}…`}
            />
          </label>
        ))}
      </div>

      {update.error && (
        <p className="text-xs text-red-500">
          {(update.error as Error).message}
        </p>
      )}

      <div className="flex gap-2">
        <button
          className="cursor-pointer rounded-lg bg-primary px-5 py-2 font-medium text-primary-foreground disabled:opacity-50"
          disabled={update.isPending || !allRequiredFilled}
          onClick={save}
        >
          {update.isPending ? "Saving…" : "Save key"}
        </button>
        <button
          className="cursor-pointer rounded-lg border border-border px-5 py-2"
          onClick={close}
          disabled={update.isPending}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
