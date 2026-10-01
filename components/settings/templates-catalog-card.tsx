"use client";

import { useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { BusyLabel } from "@/components/agents-page/agents-tab/steps/busy-label";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useSetTemplatesCatalog, useTemplatesCatalog } from "@/lib/queries/templates-catalog";
import { BYPASS_TOKEN_PATTERN, isVercelPreviewOrigin, parseDevOrigin } from "@/lib/templates/cloud/catalog-origin";

/** Said beside the optional token: Development works with just an address. */
export const BYPASS_TOKEN_HINT = "Only needed if Deployment Protection is on.";

/**
 * Settings → Templates → Catalog, in a DEV build only: read and publish to the
 * production templates catalog, or to a development site — the local
 * libi-site or a Vercel preview of it — while fixing libi itself. A packaged
 * build has no such setting (the tab isn't shown, and the server refuses).
 *
 * The development address is all Development needs. A Vercel preview behind
 * Deployment Protection also needs the project's bypass secret: optional,
 * tucked under a disclosure, only for an https `*.vercel.app` address, never
 * shown back (the server says only whether one is set), and cleared by the
 * server when the address changes.
 */
export function TemplatesCatalogCard() {
  const catalog = useTemplatesCatalog();
  const save = useSetTemplatesCatalog();
  const view = catalog.data;
  const [draftOrigin, setDraftOrigin] = useState<string | null>(null);
  const [tokenOpen, setTokenOpen] = useState(false);
  const [token, setToken] = useState("");
  const [error, setError] = useState<string | null>(null);

  if (!view) {
    return catalog.isError ? (
      <div data-testid="templates-catalog-error" className="flex items-center gap-2 text-sm text-muted-foreground">
        <span>Couldn&rsquo;t load the catalog setting.</span>
        <Button variant="outline" size="sm" className="cursor-pointer" onClick={() => void catalog.refetch()}>
          Retry
        </Button>
      </div>
    ) : (
      <div data-testid="templates-catalog-skeleton" className="space-y-3">
        <Skeleton className="h-4 w-24" />
        <Skeleton className="h-4 w-80" />
        <div className="flex gap-2">
          <Skeleton className="h-9 w-28 rounded-md" />
          <Skeleton className="h-9 w-28 rounded-md" />
        </div>
        <Skeleton className="h-8 w-96 rounded-md" />
      </div>
    );
  }
  if (!view.devBuild) {
    return (
      <p data-testid="templates-catalog-packaged" className="text-sm text-muted-foreground">
        This libi reads the templates catalog at {view.active.host ?? "the test-mode fixture"}.
      </p>
    );
  }

  const storedOrigin = view.development.origin ?? "";
  const originText = draftOrigin ?? storedOrigin;
  const parsed = originText.trim() ? parseDevOrigin(originText) : null;
  const originDirty = draftOrigin !== null && parsed?.ok === true && parsed.origin !== view.development.origin;
  const vercel = isVercelPreviewOrigin(parsed?.ok ? parsed.origin : view.development.origin);
  // One creator key serves both catalogs (review M11): a development site that is not this machine receives it.
  const keyLeavesMachine = parsed?.ok === true && !["localhost", "127.0.0.1"].includes(new URL(parsed.origin).hostname);
  const tokenValid = BYPASS_TOKEN_PATTERN.test(token.trim());
  const pending = save.isPending ? save.variables : null;

  const run = (change: Parameters<typeof save.mutate>[0], after?: () => void) => {
    setError(null);
    save.mutate(change, {
      onSuccess: () => after?.(),
      onError: (e) => setError(e.message),
    });
  };

  const choose = (choice: "production" | "development") => {
    if (choice === view.choice && !originDirty) return;
    if (choice === "development") {
      if (!parsed?.ok) return setError(parsed ? parsed.error : "Enter the development site's address first.");
      run({ choice, ...(originDirty ? { devOrigin: parsed.origin } : {}) }, () => setDraftOrigin(null));
    } else run({ choice });
  };

  const option = (choice: "production" | "development", label: string, detail: string) => (
    <Button
      variant={view.choice === choice ? "default" : "outline"}
      className="h-auto cursor-pointer flex-col items-start gap-0.5 px-3 py-2 text-left"
      data-testid={`templates-catalog-${choice}`}
      aria-pressed={view.choice === choice}
      disabled={save.isPending}
      onClick={() => choose(choice)}
    >
      <span className="text-sm font-medium">{pending?.choice === choice ? <BusyLabel>Switching…</BusyLabel> : label}</span>
      <span className="text-xs font-normal opacity-80">{detail}</span>
    </Button>
  );

  return (
    <div data-testid="templates-catalog-card" className="space-y-4">
      <div>
        <h3 className="text-sm font-semibold text-foreground">Catalog</h3>
        <p className="mt-1 text-sm text-muted-foreground">
          Development builds only. Which public templates catalog libi browses, installs from and publishes to. The same
          creator key is used for both. Uses of an installed template are always reported to the catalog it came from.
        </p>
        {view.testMode && (
          <p data-testid="templates-catalog-test-mode" className="mt-1 text-xs text-muted-foreground">
            Test mode always uses its own fixture catalog; this setting applies outside test mode.
          </p>
        )}
      </div>

      <div className="flex flex-wrap gap-2">
        {option("production", "Production", view.production.host)}
        {option("development", "Development", view.development.origin ? new URL(view.development.origin).host : "No address yet")}
      </div>

      <div className="space-y-1.5">
        <label htmlFor="templates-catalog-origin" className="text-sm font-medium">
          Development site
        </label>
        <div className="flex flex-wrap items-center gap-2">
          <input
            id="templates-catalog-origin"
            data-testid="templates-catalog-origin"
            value={originText}
            onChange={(e) => {
              setDraftOrigin(e.target.value);
              setError(null);
            }}
            placeholder="https://libi-site-git-<branch>-<team>.vercel.app"
            autoComplete="off"
            spellCheck={false}
            aria-invalid={parsed !== null && !parsed.ok}
            className="w-96 max-w-full rounded-md border border-border bg-background px-2 py-1 font-mono text-sm aria-invalid:border-destructive"
          />
          <Button
            variant="outline"
            className="cursor-pointer"
            data-testid="templates-catalog-origin-save"
            disabled={!originDirty || save.isPending}
            onClick={() => parsed?.ok && run({ devOrigin: parsed.origin }, () => setDraftOrigin(null))}
          >
            {pending?.devOrigin !== undefined && pending.choice === undefined ? <BusyLabel>Saving…</BusyLabel> : "Save address"}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          {view.development.isDefault
            ? "From NEXT_PUBLIC_LIBI_SITE_URL. "
            : !view.development.origin && !view.development.defaultOrigin
              ? "Paste the site's stable preview address (the branch alias). "
              : ""}
          https:// any site, or http://localhost / 127.0.0.1 for a site on this machine.
        </p>
        {keyLeavesMachine && (
          <p data-testid="templates-catalog-key-note" className="text-xs text-muted-foreground">
            Your creator key is sent to this site.
          </p>
        )}
        {parsed && !parsed.ok && (
          <p data-testid="templates-catalog-origin-problem" className="text-xs text-destructive">
            {parsed.error}
          </p>
        )}
      </div>

      {vercel && (
        <div data-testid="templates-catalog-token" className="space-y-1.5">
          <button
            type="button"
            data-testid="templates-catalog-token-toggle"
            className="flex cursor-pointer items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
            aria-expanded={tokenOpen}
            onClick={() => setTokenOpen((o) => !o)}
          >
            {tokenOpen ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
            Vercel bypass token <span className="text-xs">(optional{view.bypassToken.set ? " — set" : ""})</span>
          </button>
          {tokenOpen && (
            <div className="space-y-1.5 pl-5">
              <p className="text-xs text-muted-foreground">
                {BYPASS_TOKEN_HINT} Sent only to this address, never shown again.
              </p>
              <div className="flex flex-wrap items-center gap-2">
                <input
                  type="password"
                  data-testid="templates-catalog-token-input"
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                  placeholder={view.bypassToken.set ? "••••••••  (set)" : "Protection Bypass for Automation secret"}
                  aria-label="Vercel protection bypass token"
                  autoComplete="off"
                  spellCheck={false}
                  className="w-80 max-w-full rounded-md border border-border bg-background px-2 py-1 font-mono text-sm"
                />
                <Button
                  variant="outline"
                  className="cursor-pointer"
                  data-testid="templates-catalog-token-save"
                  disabled={!tokenValid || save.isPending || originDirty}
                  onClick={() => run({ bypassToken: token.trim() }, () => setToken(""))}
                >
                  {typeof pending?.bypassToken === "string" ? <BusyLabel>Saving…</BusyLabel> : view.bypassToken.set ? "Replace" : "Set"}
                </Button>
                {view.bypassToken.set && (
                  <Button variant="ghost" className="cursor-pointer" data-testid="templates-catalog-token-clear" disabled={save.isPending} onClick={() => run({ bypassToken: null })}>
                    Clear
                  </Button>
                )}
              </div>
              {originDirty && <p className="text-xs text-muted-foreground">Save the address first: a token belongs to one address.</p>}
            </div>
          )}
        </div>
      )}

      {error && (
        <p data-testid="templates-catalog-error-message" role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
