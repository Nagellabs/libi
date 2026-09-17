"use client";

import { useEffect } from "react";
import { McpServersView } from "../mcp-servers-view";
import { MCP_SCROLL_EVENT, setPendingMcpScroll } from "@/lib/mcp-scroll-intent";
import { EndpointCard } from "./endpoint-card";
import { ActiveSessions } from "./active-sessions";

/**
 * libi's own MCP: the endpoint, who is using it, and its extensions. Registering
 * it with the user's own Claude Code and Codex lives on the Global setup tab.
 *
 * `?extension=<id>` is handed to the extensions list both ways it listens: the
 * live event (it is already mounted — children's effects run first) and the
 * parked intent, in case the list mounts later.
 */
export function LibiMcpTab({ extension }: { extension: string | null }) {
  useEffect(() => {
    if (!extension) return;
    setPendingMcpScroll(extension);
    window.dispatchEvent(new CustomEvent(MCP_SCROLL_EVENT, { detail: { mcpId: extension } }));
  }, [extension]);

  return (
    <div className="space-y-8">
      <EndpointCard />
      <ActiveSessions />
      <section className="space-y-3">
        <h2 className="text-sm font-medium uppercase tracking-wide text-muted-foreground">libi extensions</h2>
        <McpServersView />
      </section>
    </div>
  );
}
