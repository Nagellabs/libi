"use client";

import { ConnectedAgents } from "./connected-agents";
import { SmallPrint } from "./small-print";

/**
 * Using libi from the user's OWN Claude Code and Codex, outside libi: for the
 * agent picked in the Claude Code | Codex switch, libi's tools (the Libi MCP
 * registration) and libi's skills (every folder or specific folders), plus the
 * one terminal command that does the same. Nothing here is about libi's own
 * chats, which always have both.
 */
export function GlobalSetupTab() {
  return (
    <div className="space-y-6">
      <section aria-label="Claude Code and Codex setup" className="space-y-3">
        <div className="space-y-1">
          <p className="text-sm text-muted-foreground">
            Add Libi MCP to your global Claude Code and Codex configuration to use it from the Claude Code and Codex apps and
            terminals.
          </p>
          <p className="text-xs text-muted-foreground">libi&#39;s own chats and terminal always have libi&#39;s tools and skills.</p>
        </div>
        <ConnectedAgents />
      </section>
      <SmallPrint />
    </div>
  );
}
