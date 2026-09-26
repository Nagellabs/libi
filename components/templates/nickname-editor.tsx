"use client";

import { useState } from "react";
import { Pencil } from "lucide-react";
import { BusyLabel } from "@/components/agents-page/agents-tab/steps/busy-label";
import { Skeleton } from "@/components/ui/skeleton";
import { useCloudMine, useSetNickname, useTemplatesAuthor } from "@/lib/queries/templates-cloud";
import { parseNickname } from "@/lib/templates/cloud/author-rules";
import { CREATOR_NOT_APPROVED_RENAME_MESSAGE } from "@/lib/templates/cloud/constants";

/**
 * A refused save, in the route's words — except `creator_not_approved`, which
 * is always said as a RENAME refusal (the author owns templates in the
 * catalog and isn't an approved creator): never the publish refusal's
 * "Nothing was published.", never advice to hide them. (By its code,
 * duck-typed: `CloudRouteError`.)
 */
function setErrorText(err: Error): string {
  return (err as { code?: unknown }).code === "creator_not_approved" ? CREATOR_NOT_APPROVED_RENAME_MESSAGE : err.message;
}

export interface NicknameEditorTestIds {
  skeleton: string;
  loadError: string;
  edit: string;
  input: string;
  error: string;
}

const PUBLISHING_AS_IDS: NicknameEditorTestIds = {
  skeleton: "publishing-as-skeleton",
  loadError: "publishing-as-load-error",
  edit: "publishing-as-edit",
  input: "nickname-input",
  error: "nickname-error",
};

/**
 * The public nickname, shown and edited inline — "Publishing as" on the
 * Templates page and the creator-key card in Settings → General. Every user
 * has one from the first view (reading the author creates the identity): a
 * random default ("Brave Otter 4821", lib/templates/cloud/default-nickname.ts)
 * until they rename it here. Held to the site's nickname rule as the user types.
 *
 * The nickname is the SITE's: `/mine` says what the catalog shows, and wins
 * over the local copy, which a key imported offline or a rename on another
 * machine leaves stale. Only when the catalog has no word — offline, nothing
 * published yet — does the local value (the default, before a first publish)
 * stand. A read that failed says so, with a retry, rather than offering an
 * empty name to fill in.
 */
export function NicknameEditor({ label, align = "end", testIds = PUBLISHING_AS_IDS }: { label: string; align?: "start" | "end"; testIds?: NicknameEditorTestIds }) {
  const author = useTemplatesAuthor();
  const mine = useCloudMine();
  const set = useSetNickname();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState("");
  const siteNickname = mine.data && !mine.data.error ? mine.data.nickname : null;
  const nickname = siteNickname ?? author.data?.nickname ?? null;
  const loading = nickname === null;
  const parsed = parseNickname(value);
  const localError = editing && value.trim().length > 0 && !parsed.ok ? parsed.error : null;
  const error = localError ?? (editing && set.error ? setErrorText(set.error) : null);

  const cancel = () => {
    set.reset();
    setEditing(false);
  };
  const commit = () => {
    if (set.isPending) return;
    if (value.trim() === "" || (parsed.ok && parsed.nickname === nickname)) return cancel();
    if (!parsed.ok) return;
    set.mutate(parsed.nickname, { onSuccess: () => setEditing(false) });
  };

  return (
    <div className={`flex flex-col gap-1 ${align === "end" ? "items-end" : "items-start"}`}>
      <div className="flex items-center gap-2 text-muted-foreground">
        <span>{label}</span>
        {author.isError && nickname === null ? (
          <span data-testid={testIds.loadError} className="inline-flex items-center gap-2 text-xs">
            Couldn&rsquo;t load your nickname.
            <button type="button" className="cursor-pointer font-medium text-foreground hover:underline" onClick={() => void author.refetch()}>
              Retry
            </button>
          </span>
        ) : loading ? (
          <Skeleton data-testid={testIds.skeleton} className="h-5 w-24 rounded" />
        ) : editing ? (
          <>
            <input
              data-testid={testIds.input}
              autoFocus
              value={value}
              maxLength={64}
              disabled={set.isPending}
              aria-label="Nickname"
              aria-invalid={error !== null}
              onChange={(e) => {
                setValue(e.target.value);
                if (set.error) set.reset();
              }}
              onBlur={commit}
              onKeyDown={(e) => {
                if (e.key === "Enter") commit();
                if (e.key === "Escape") cancel();
              }}
              className="w-44 rounded-md border border-border bg-background px-2 py-0.5 text-sm text-foreground aria-invalid:border-destructive"
            />
            {set.isPending ? (
              <span className="inline-flex items-center gap-1 text-xs">
                <BusyLabel>Saving…</BusyLabel>
              </span>
            ) : null}
          </>
        ) : (
          <button
            type="button"
            data-testid={testIds.edit}
            title="Change your public nickname"
            className="inline-flex cursor-pointer items-center gap-1 font-semibold text-foreground hover:underline"
            onClick={() => {
              set.reset();
              setValue(nickname ?? "");
              setEditing(true);
            }}
          >
            {nickname}
            <Pencil className="size-3" />
          </button>
        )}
      </div>
      {error ? (
        <p data-testid={testIds.error} className={`max-w-xs text-xs text-destructive ${align === "end" ? "text-right" : ""}`}>
          {error}
        </p>
      ) : null}
    </div>
  );
}
