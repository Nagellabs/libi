"use client";

import { useEffect, useRef, useState } from "react";
import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { McpServerCard } from "@/components/settings/mcp-server-card";
import { useMcpServers, useResyncMcpServers } from "@/lib/queries/mcp-servers";
import { useDocumentVisible } from "@/hooks/use-document-visible";
import { MCP_SCROLL_EVENT, takePendingMcpScroll } from "@/lib/mcp-scroll-intent";
import { EXTENSION_MCP_SERVERS } from "@/mcp/registry/bundled";

/** Classes that mark the card `libi.show_extension({ extensionId })` asked for. */
const SCROLL_HIGHLIGHT = ["ring-2", "ring-yellow-500/60"] as const;
const SCROLL_HIGHLIGHT_MS = 1500;

/**
 * The extensions section of the libi MCP tab: libi's own card with every
 * extension nested inside it, driven by the registry
 * (`BundledMcpDef.kind === "extension"`), so a new extension def shows up here
 * by construction. A DB row with no def (an extension since removed from the
 * registry, say) is simply not rendered.
 *
 * Polling: the dependency chips poll only while the document is visible. There
 * is deliberately no "is my tab on screen" prop: base-ui's `Tabs.Panel`
 * defaults to `keepMounted: false`, so this component is UNMOUNTED whenever
 * another tab is showing (the parked scroll intent below exists because of
 * exactly that) — a visibility prop could only ever be passed `true`.
 */

export function McpServersView() {
  const { data: servers, isLoading } = useMcpServers();
  const resync = useResyncMcpServers();
  // Mounted at all == this tab is on screen (see the header note), so the
  // document's own visibility is the whole of the gate.
  const polling = useDocumentVisible();

  // Every libi-owned row, in registry order. `LIBI_IDS` is gone: the registry
  // itself now says which rows are extensions (BundledMcpDef.kind).
  const byId = new Map((servers ?? []).map((s) => [s.id, s]));
  const coreRow = byId.get("libi");
  const allExtensions = EXTENSION_MCP_SERVERS.flatMap((def) => {
    const row = byId.get(def.id);
    return row ? [{ def, row }] : [];
  });
  const extensions = allExtensions.map(({ row }) => row);
  const hasFailed = [coreRow, ...allExtensions.map(({ row }) => row)].some(
    (s) => s?.installStatus === "failed",
  );

  // `libi.show_extension` reaches us two ways, and both are needed: the
  // live event when this tab is already open, and a parked intent when it is
  // not — the panel is unmounted while another tab shows, so the event has
  // nobody to reach. Either way the id is held in state until the cards have
  // actually rendered (on a fresh mount `isLoading` is still true and there is
  // no card in the DOM to scroll to yet).
  // A ref, not state: the claim below happens in an effect body, and the
  // second effect re-reads it whenever the cards finish loading.
  const scrollTargetRef = useRef<string | null>(null);
  const [scrollNonce, setScrollNonce] = useState(0);
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as { mcpId?: string } | undefined;
      if (!detail?.mcpId) return;
      takePendingMcpScroll(); // the live event wins; don't replay it on remount
      scrollTargetRef.current = detail.mcpId;
      setScrollNonce((n) => n + 1);
    };
    window.addEventListener(MCP_SCROLL_EVENT, handler);
    // Guarded: StrictMode runs this effect twice, and an unguarded assignment
    // would overwrite the id the first pass claimed with the second's null.
    const parked = takePendingMcpScroll();
    if (parked) scrollTargetRef.current = parked;
    return () => window.removeEventListener(MCP_SCROLL_EVENT, handler);
  }, []);

  useEffect(() => {
    const target = scrollTargetRef.current;
    if (!target || isLoading) return;
    scrollTargetRef.current = null;
    const card = document.querySelector(`#mcp-${CSS.escape(target)}`);
    if (!card) return;
    // `behavior: "smooth"` is an ANIMATION, and a browser runs no animation
    // frames for a HIDDEN document — the scroll is not deferred or clipped,
    // it is dropped whole, leaving the scroller at 0 with no error and no
    // partial movement. That is the ORDINARY case for this tool: the agent
    // calls it while the user is reading the chat in another tab or another
    // window, which is exactly why they need to be put on the card.
    //
    // Measured on the running page, same element, same 2429 px scroller:
    // `scrollIntoView({behavior:"smooth"})` -> scrollTop 0 after 1.5 s;
    // `scrollIntoView()` -> scrollTop 774 immediately. (The parked-intent
    // hand-off in `lib/mcp-scroll-intent.ts` was never the problem — this
    // effect does run, and it did call scrollIntoView on the right element.)
    const visible = document.visibilityState === "visible";
    card.scrollIntoView({ behavior: visible ? "smooth" : "auto", block: "start" });
    card.classList.add(...SCROLL_HIGHLIGHT);
    // Same reasoning for the highlight: burning its 1.5 s while the page is
    // hidden means the user returns to a card with nothing marking it. Start
    // the clock when they can actually see it.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const clear = () => card.classList.remove(...SCROLL_HIGHLIGHT);
    const arm = () => {
      timer = setTimeout(clear, SCROLL_HIGHLIGHT_MS);
    };
    const onVisibility = () => {
      if (document.visibilityState !== "visible") return;
      document.removeEventListener("visibilitychange", onVisibility);
      arm();
    };
    if (visible) arm();
    else document.addEventListener("visibilitychange", onVisibility);
    return () => {
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibility);
      clear();
    };
  }, [scrollNonce, isLoading]);

  if (isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-24 w-full" />
      </div>
    );
  }

  return (
    <div className="space-y-8">
      {hasFailed && (
        <div className="flex items-center justify-end gap-2">
          <Button
            variant="outline"
            size="sm"
            className="cursor-pointer"
            onClick={() => resync.mutate()}
            disabled={resync.isPending}
          >
            <RefreshCw className={`size-3.5 mr-1.5 ${resync.isPending ? "animate-spin" : ""}`} />
            Resync
          </Button>
        </div>
      )}

      <section className="space-y-3">
        {coreRow ? (
          <McpServerCard server={coreRow} extensions={extensions} polling={polling} />
        ) : (
          <p className="text-sm text-muted-foreground">
            libi&rsquo;s own row isn&rsquo;t registered yet — restart libi.
          </p>
        )}
      </section>
    </div>
  );
}
