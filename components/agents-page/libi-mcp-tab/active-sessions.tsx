"use client";

import { Skeleton } from "@/components/ui/skeleton";
import { useDocumentVisible } from "@/hooks/use-document-visible";
import { useMcpSessions } from "@/lib/queries/mcp-health";

/**
 * How many clients hold a session on libi's endpoint, split by where they come
 * from. The poll runs only while this tab is on screen: the tab panel unmounts
 * when another tab is active, and the document gate covers a hidden window.
 */
export function ActiveSessions() {
  const { data } = useMcpSessions({ enabled: useDocumentVisible() });

  let body: React.ReactNode;
  if (!data) {
    body = <Skeleton className="h-4 w-64" />;
  } else if (!data.sessionsBy) {
    // No breakdown. Only an endpoint that did not answer is "unreachable"; one
    // that answered without the split still shows whatever total it gave.
    body = (
      <p data-testid="active-sessions" className="text-sm text-muted-foreground">
        {!data.ok
          ? "No session count while the endpoint is unreachable."
          : typeof data.sessions === "number"
            ? `${data.sessions} active`
            : "No session count reported."}
      </p>
    );
  } else {
    const { inApp, cli } = data.sessionsBy;
    const total = data.sessions ?? inApp.claude + inApp.codex + cli.claude + cli.codex;
    body = (
      <p data-testid="active-sessions" className="text-sm text-foreground">
        {total} active: in-app chat {inApp.claude + inApp.codex} · Claude Code CLI {cli.claude} · Codex CLI {cli.codex}
      </p>
    );
  }

  return (
    <section className="space-y-3">
      <h2 className="text-sm font-medium uppercase tracking-wide text-muted-foreground">Active sessions</h2>
      {body}
    </section>
  );
}
