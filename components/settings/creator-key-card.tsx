"use client";

import { useState } from "react";
import { Copy, Eye, EyeOff, TriangleAlert } from "lucide-react";
import { toast } from "sonner";
import { BusyLabel } from "@/components/agents-page/agents-tab/steps/busy-label";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { NicknameEditor } from "@/components/templates/nickname-editor";
import { CloudRouteError, REPLACE_REQUIRED, revealCreatorKey, useCloudMine, useCreatorKeyStatus, useImportCreatorKey } from "@/lib/queries/templates-cloud";
import { CREATOR_KEY_PATTERN, NOT_A_CREATOR_KEY, maskCreatorKey } from "@/lib/templates/cloud/author-rules";

/**
 * Settings → General: the public catalog's creator key. It is a bearer secret
 * — whoever holds it can edit this install's published templates — so the
 * card loads only its mask, and fetches the key itself (a guarded POST) only
 * when the user clicks Reveal or Copy. A revealed key lives in this card's
 * state alone: Hide, unmount, or a different stored key drops it. Replacing
 * the key takes a second confirmation, with a copy of the old one on offer:
 * the templates published under it stop being editable from here. Whether a
 * pasted key replaces the stored one is the server's call — it compares the
 * whole key, and a different key can share the mask this card sees.
 *
 * There is always a key to show: reading the status creates the identity, with
 * a random default nickname, on the first view. Below the key, that public
 * nickname, editable in place (`NicknameEditor`, shared with "Publishing as").
 *
 * The replacement warning shows only for a USED key — something published
 * under it here (`publishedHere`) or on the site (`/mine` lists any, readable
 * or not, holds a nickname for it, or can't be read): the key libi made on first view, never used, is replaced without
 * a word, and the server decides the same way (lib/templates/cloud/key-usage.ts).
 */
export function CreatorKeyCard() {
  const creatorKey = useCreatorKeyStatus();
  const mine = useCloudMine();
  const importKey = useImportCreatorKey();
  const [revealed, setRevealed] = useState<string | null>(null);
  const [revealing, setRevealing] = useState(false);
  const [importing, setImporting] = useState(false);
  const [confirmingReplace, setConfirmingReplace] = useState(false);
  const [pasted, setPasted] = useState("");
  const data = creatorKey.data;
  // A doubt (the site not read yet, or unreadable) counts as used: the warning is the safe side.
  // Entries libi couldn't read are still the key's, and a nickname on the site was chosen under it.
  const siteUsed = mine.data ? Boolean(mine.data.error) || mine.data.templates.length > 0 || (mine.data.dropped ?? 0) > 0 || mine.data.nickname !== null : true;
  const keyUsed = Boolean(data?.publishedHere) || siteUsed;
  // Shown only while it is still the stored key: an import elsewhere changes the mask.
  const shownKey = revealed !== null && data?.masked === maskCreatorKey(revealed) ? revealed : null;
  const candidate = pasted.trim();
  const candidateValid = CREATOR_KEY_PATTERN.test(candidate);

  const closeImport = () => {
    setPasted("");
    setConfirmingReplace(false);
    setImporting(false);
  };

  const toggleReveal = async () => {
    if (shownKey) return setRevealed(null);
    setRevealing(true);
    try {
      setRevealed(await revealCreatorKey());
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't reveal the creator key");
    } finally {
      setRevealing(false);
    }
  };

  /** Copy without revealing: the key is fetched for this click and kept nowhere. */
  const copyKey = async () => {
    try {
      await navigator.clipboard.writeText(shownKey ?? (await revealCreatorKey()));
      toast.success("Creator key copied");
    } catch {
      toast.error("Couldn't copy the key — reveal it and copy it by hand.");
    }
  };

  /** First without `replace`: the server answers `replace_required` when the key differs, and the confirmation asks. */
  const submitImport = (replace: boolean) =>
    importKey.mutate(
      { key: candidate, replace },
      {
        onSuccess: () => {
          closeImport();
          setRevealed(null);
        },
        onError: (err) => {
          if (err instanceof CloudRouteError && err.code === REPLACE_REQUIRED) setConfirmingReplace(true);
        },
      },
    );

  const importButton = (
    <Button
      variant="ghost"
      className="cursor-pointer"
      data-testid="creator-key-import-open"
      onClick={() => (importing ? closeImport() : setImporting(true))}
    >
      Import a key
    </Button>
  );

  const body = () => {
    if (!data) {
      return creatorKey.isError ? (
        <div data-testid="creator-key-error" className="mt-3 flex items-center gap-2 text-sm text-muted-foreground">
          <span>Couldn&rsquo;t load the creator key.</span>
          <Button variant="outline" size="sm" className="cursor-pointer" onClick={() => void creatorKey.refetch()}>
            Retry
          </Button>
        </div>
      ) : (
        <div data-testid="creator-key-skeleton" className="mt-3 flex gap-2">
          <Skeleton className="h-8 w-40 rounded-md" />
          <Skeleton className="h-8 w-20 rounded-md" />
          <Skeleton className="h-8 w-20 rounded-md" />
        </div>
      );
    }
    return (
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {shownKey ? (
          <code data-testid="creator-key-full" className="break-all rounded-md border border-border bg-muted px-2 py-1 font-mono text-sm select-all">
            {shownKey}
          </code>
        ) : (
          <code data-testid="creator-key-masked" className="rounded-md border border-border bg-muted px-2 py-1 font-mono text-sm">
            {data.masked}
          </code>
        )}
        <Button variant="outline" className="cursor-pointer" data-testid="creator-key-reveal" disabled={revealing} onClick={() => void toggleReveal()}>
          {revealing ? (
            <BusyLabel>Revealing…</BusyLabel>
          ) : (
            <>
              {shownKey ? <EyeOff className="mr-2 size-4" /> : <Eye className="mr-2 size-4" />}
              {shownKey ? "Hide" : "Reveal"}
            </>
          )}
        </Button>
        <Button variant="outline" className="cursor-pointer" data-testid="creator-key-copy" onClick={() => void copyKey()}>
          <Copy className="mr-2 size-4" />
          Copy
        </Button>
        {importButton}
      </div>
    );
  };

  return (
    <div data-testid="creator-key-card">
      <h3 className="text-sm font-semibold text-foreground">Templates creator key</h3>
      <p className="mt-1 text-sm text-muted-foreground">
        Anyone with this key can edit your published templates. Keep it private, and keep a copy somewhere safe: without
        it, nobody — not even libi — can edit them again. Import it on another machine to publish as the same author
        {data?.nickname ? (
          <>
            {" "}
            (<strong>{data.nickname}</strong>)
          </>
        ) : null}
        .
      </p>
      {body()}
      {data ? (
        <div data-testid="creator-key-nickname" className="mt-3 text-sm">
          <NicknameEditor
            label="Public nickname"
            align="start"
            testIds={{ skeleton: "creator-key-nickname-skeleton", loadError: "creator-key-nickname-load-error", edit: "creator-key-nickname-edit", input: "creator-key-nickname-input", error: "creator-key-nickname-error" }}
          />
        </div>
      ) : null}
      {importing ? (
        <div className="mt-3 space-y-2" data-testid="creator-key-import">
          {keyUsed ? (
            <p
              data-testid="creator-key-import-warning"
              className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-500"
            >
              <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
              <span>
                Importing replaces this install&rsquo;s key. Templates published with the current key can no longer be
                edited, hidden or updated from here unless you import it again — copy it first. A publish still in
                progress under it will need that key to finish.
              </span>
            </p>
          ) : null}
          <div className="flex flex-wrap items-center gap-2">
            <input
              data-testid="creator-key-input"
              value={pasted}
              onChange={(e) => {
                setPasted(e.target.value);
                setConfirmingReplace(false);
              }}
              placeholder="Paste a creator key"
              aria-label="Creator key to import"
              aria-invalid={candidate.length > 0 && !candidateValid}
              autoComplete="off"
              spellCheck={false}
              className="w-96 max-w-full rounded-md border border-border bg-background px-2 py-1 font-mono text-sm aria-invalid:border-destructive"
            />
            {!confirmingReplace ? (
              <Button
                className="cursor-pointer"
                data-testid="creator-key-import-submit"
                disabled={importKey.isPending || !candidateValid}
                onClick={() => submitImport(false)}
              >
                {importKey.isPending ? <BusyLabel>Importing…</BusyLabel> : "Use this key"}
              </Button>
            ) : null}
            <Button variant="ghost" className="cursor-pointer" onClick={closeImport}>
              Cancel
            </Button>
          </div>
          {confirmingReplace ? (
            <div data-testid="creator-key-replace-confirm" className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <span>This is a different key from the one in use, which is overwritten for good. Keep a copy of it first.</span>
              <Button variant="outline" size="sm" className="cursor-pointer" onClick={() => void copyKey()}>
                <Copy className="mr-2 size-4" />
                Copy the current key
              </Button>
              <Button
                variant="destructive"
                size="sm"
                className="cursor-pointer"
                data-testid="creator-key-replace-confirm-submit"
                disabled={importKey.isPending}
                onClick={() => submitImport(true)}
              >
                {importKey.isPending ? <BusyLabel>Importing…</BusyLabel> : "Replace it — I have a copy of the old key"}
              </Button>
            </div>
          ) : null}
          {candidate.length > 0 && !candidateValid ? (
            <p data-testid="creator-key-input-error" className="text-xs text-destructive">
              {NOT_A_CREATOR_KEY}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
