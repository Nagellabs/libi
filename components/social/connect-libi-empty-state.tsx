"use client";

import { Button } from "@/components/ui/button";
import { useConnectLibi } from "@/lib/queries/social";

/**
 * libi's own Zernio connection is separate from the agent's — the agent can
 * post right now even when this panel is showing. The copy below is fixed
 * verbatim by the social-posting spec; do not paraphrase it.
 */
export function ConnectLibiEmptyState({ variant }: { variant: "never" | "revoked" }) {
  const connect = useConnectLibi();
  const go = async () => {
    const { url } = await connect.mutateAsync();
    window.open(url, "_blank", "noopener");
  };
  return (
    <div data-testid="social-connect-libi" className="mx-auto max-w-md rounded-lg border border-border bg-card p-5 text-sm">
      {variant === "never" ? (
        <>
          <p className="font-medium">Connect libi to Zernio to see your posts here.</p>
          <p className="mt-2 text-muted-foreground">
            This is libi&apos;s own view of your Zernio account. Your agent&apos;s connection is separate and still
            works — it can post right now, this page just can&apos;t show you anything until libi is connected.
          </p>
        </>
      ) : (
        <p className="font-medium">libi&apos;s connection was revoked. Your agent&apos;s connection is unaffected.</p>
      )}
      <Button className="mt-4 cursor-pointer" onClick={() => void go()} disabled={connect.isPending}>
        {connect.isPending ? "Opening your browser…" : variant === "never" ? "Connect libi" : "Reconnect libi"}
      </Button>
      <p className="mt-3 text-xs text-muted-foreground">
        You approve libi in your browser at Zernio. Nothing is pasted; the grant is kept in your keychain (desktop
        app) or a private file in your libi home (npx), and you can revoke it here or at Zernio.
      </p>
    </div>
  );
}
