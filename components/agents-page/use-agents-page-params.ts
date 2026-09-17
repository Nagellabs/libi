"use client";

import { useCallback, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import type { SetupAgentId } from "@/lib/agents/setup/commands";
import { isSetupAgentId } from "@/lib/agents/setup/registry";
import { useEditorState } from "@/lib/editor-state-context";

export const AGENTS_TABS = ["agents", "global-setup", "skills", "libi-mcp", "providers"] as const;
export type AgentsTab = (typeof AGENTS_TABS)[number];
export const DEFAULT_AGENTS_TAB: AgentsTab = "agents";

export interface AgentsPageParams {
  tab: AgentsTab;
  /** `?agent=` — opens the setup wizard with this agent already chosen. */
  agent: SetupAgentId | null;
  /** `?provider=` — the Providers tab shows only that row, highlighted. */
  provider: string | null;
  /** `?setupAgent=` — the agent the setup tabs show (`useSetupAgent`). Kept across tab switches. */
  setupAgent: SetupAgentId | null;
  /** `?extension=` — the libi MCP tab scrolls to and highlights that card. */
  extension: string | null;
  /** `?from=<sessionId>` — the chat that sent the user here; renders Back to chat. */
  from: string | null;
}

export function isAgentsTab(v: string | null): v is AgentsTab {
  return v !== null && (AGENTS_TABS as readonly string[]).includes(v);
}

function agentParam(v: string | null): SetupAgentId | null {
  return v !== null && isSetupAgentId(v) ? v : null;
}

/** Pure: the URL's params, defaulted and validated. Junk reads as absent. */
export function parseAgentsPageParams(sp: URLSearchParams): AgentsPageParams {
  const tab = sp.get("tab");
  return {
    tab: isAgentsTab(tab) ? tab : DEFAULT_AGENTS_TAB,
    agent: agentParam(sp.get("agent")),
    provider: sp.get("provider") || null,
    setupAgent: agentParam(sp.get("setupAgent")),
    extension: sp.get("extension") || null,
    from: sp.get("from") || null,
  };
}

/**
 * The page's last URL write, while it may not have landed yet.
 *
 * Next puts a `router.replace` URL into history only when that navigation
 * commits, so for a moment after a write both `useSearchParams()` and
 * `window.location` still show the query from before it. A second write built
 * from either — a tab click right after an agent pick — would drop what the
 * first one added. So a write starts from this query while the history entry
 * is still the one that write started from; any commit or back/forward replaces
 * that entry, and then the URL as it is now is the start again.
 */
let lastWrite: { from: string; fromState: unknown; query: string } | null = null;

/** The params to build the next write from: the current URL, plus a write that hasn't landed in it yet. */
function currentParams(): URLSearchParams {
  const pending =
    lastWrite !== null && window.history.state === lastWrite.fromState && window.location.search === lastWrite.from
      ? lastWrite
      : null;
  lastWrite = pending;
  return new URLSearchParams(pending ? pending.query : window.location.search);
}

function replaceParams(router: ReturnType<typeof useRouter>, pathname: string, params: URLSearchParams): void {
  const query = params.toString();
  lastWrite = { from: window.location.search, fromState: window.history.state, query };
  router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
}

/**
 * URL ↔ state sync. The URL is the source of truth for back/forward and deep
 * links; a tab click writes it back with `router.replace`, keeping `from` and
 * dropping the params that belong to the tab being left (`agent`, `extension`,
 * `provider`) — otherwise coming back to a tab would re-open a wizard the user
 * closed, or re-filter it. `setupAgent` is a choice shared by the setup tabs,
 * not a filter, so it stays: the next setup tab shows the agent the user picked.
 * Every writer here builds from the current URL at write time (`currentParams`),
 * so a tab click never drops a param another write just added. External URL
 * changes are adopted during render (React's previous-state pattern) rather than
 * in an effect — the re-render happens before paint, with no effect cascade.
 */
export function useAgentsPageParams(): AgentsPageParams & { setTab: (t: AgentsTab) => void } {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const urlParams = parseAgentsPageParams(searchParams);
  const [tab, setTabState] = useState<AgentsTab>(urlParams.tab);
  const [prevUrlTab, setPrevUrlTab] = useState(urlParams.tab);
  if (urlParams.tab !== prevUrlTab) {
    setPrevUrlTab(urlParams.tab);
    if (urlParams.tab !== tab) setTabState(urlParams.tab);
  }
  const setTab = useCallback(
    (next: AgentsTab) => {
      setTabState(next);
      const params = currentParams();
      params.set("tab", next);
      if (next !== "agents") params.delete("agent");
      if (next !== "libi-mcp") params.delete("extension");
      if (next !== "providers") params.delete("provider");
      replaceParams(router, pathname, params);
    },
    [pathname, router],
  );
  return { ...urlParams, tab, setTab };
}

/**
 * The ONE agent the setup tabs (Providers, Global setup) show, and the setter
 * their Claude Code | Codex switch calls. `?setupAgent=` when the URL names
 * one, else the agent selected in the sidebar. A pick is shown at once and
 * written to the URL with `router.replace`, keeping every other param, so the
 * other setup tab, a reload and a copied link all show the same agent; a new
 * `?setupAgent=` (back/forward, a deep link while the tab is open) wins again.
 */
export function useSetupAgent(): [SetupAgentId, (next: SetupAgentId) => void] {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { activeProviderId } = useEditorState();
  const urlAgent = parseAgentsPageParams(searchParams).setupAgent;
  const [picked, setPicked] = useState<SetupAgentId | null>(null);
  const [prevUrlAgent, setPrevUrlAgent] = useState(urlAgent);
  if (urlAgent !== prevUrlAgent) {
    setPrevUrlAgent(urlAgent);
    setPicked(null);
  }
  const agent = picked ?? urlAgent ?? (activeProviderId === "codex" ? "codex" : "claude-code");
  const setAgent = useCallback(
    (next: SetupAgentId) => {
      setPicked(next);
      const params = currentParams();
      if (params.get("setupAgent") === next) return;
      params.set("setupAgent", next);
      replaceParams(router, pathname, params);
    },
    [pathname, router],
  );
  return [agent, setAgent];
}

/**
 * Removes `?agent=` from the URL with `router.replace`, keeping every other
 * param (`tab`, `from`, …). The Agents tab calls it once it has acted on the
 * deep link: tab panels unmount on a switch, so a param left behind would
 * re-open the wizard every time the user came back to the tab.
 */
export function useClearAgentParam(): () => void {
  const router = useRouter();
  const pathname = usePathname();
  return useCallback(() => {
    const params = currentParams();
    if (!params.has("agent")) return;
    params.delete("agent");
    replaceParams(router, pathname, params);
  }, [pathname, router]);
}
