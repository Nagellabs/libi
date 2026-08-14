"use client";

import { Film, Folder, MessageSquare, Plus, PanelRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { HeaderToggleButton } from "./header-toggle-button";
import { recentPieces, RECENT_PIECES_LIMIT } from "@/lib/pieces/recent";
import { formatRelativeTime } from "@/lib/utils/format";
import type { PieceSummary } from "@/lib/queries/pieces";

interface NoPieceEmptyStateProps {
  onCreatePiece: () => void;
  creating?: boolean;
  chatOpen?: boolean;
  resourcesOpen?: boolean;
  onToggleChat?: () => void;
  onToggleResources?: () => void;
  /** Every piece, unordered. The panel picks and ranks its own recents. */
  pieces?: PieceSummary[];
  onOpenPiece?: (pieceId: string) => void;
  /** True on a brand-new install: the library loaded and is genuinely empty. */
  firstRun?: boolean;
}

/**
 * "No piece open" editor empty state — the one screen whose entire job is
 * answering "what do I do now". It offers exactly two answers, in the order a
 * returning user wants them: reopen something you already have, or make a new
 * one.
 *
 * The recents list is ranked by `recentPieces` (see lib/pieces/recent.ts for
 * why never-opened pieces still appear). Rows label their timestamp honestly —
 * "Opened" only when the piece really has been opened, "Updated" otherwise.
 *
 * There are two resources affordances on purpose. The small header toggle
 * mirrors the piece/asset panels so the chrome is consistent wherever you are;
 * the labelled "Resources" button next to "New piece" appears ONLY while the
 * panel is hidden, because a user who has collapsed it is precisely the user
 * who can't see that a piece library exists. Once the panel is visible the
 * labelled button is redundant and goes away.
 *
 * `firstRun` is the brand-new-install mood: the welcome headline instead of
 * "No piece open", and none of the library affordances, because there is no
 * library yet. It renders HERE rather than as its own full-page screen for one
 * load-bearing reason — the whole onboarding (persona modal, connect-an-agent
 * takeover, and the "I'll build you a short example video" demo chip, which
 * lives in the chat panel) is part of this layout. A separate first-run page
 * replaced the layout, so the only user who never saw the onboarding was the
 * brand-new one it exists for.
 */
export function NoPieceEmptyState({
  onCreatePiece,
  creating,
  chatOpen,
  resourcesOpen,
  onToggleChat,
  onToggleResources,
  pieces,
  onOpenPiece,
  firstRun,
}: NoPieceEmptyStateProps) {
  const recents = onOpenPiece ? recentPieces(pieces ?? [], RECENT_PIECES_LIMIT) : [];
  // Nothing to browse on a brand-new install, so the labelled Resources button
  // would be an invitation to an empty room.
  const showResourcesButton = !!onToggleResources && !resourcesOpen && !firstRun;

  return (
    <div className="flex h-full flex-col bg-surface">
      {/* Header: [chat-toggle] | spacer | [resources-toggle] — same toggles as EditorPanel */}
      <div className="flex items-center gap-2 border-b border-border px-3 h-[46px] shrink-0">
        {onToggleChat && (
          <>
            <HeaderToggleButton
              icon={MessageSquare}
              active={!!chatOpen}
              title={chatOpen ? "Hide chat" : "Show chat"}
              onClick={onToggleChat}
            />
            <div className="h-4 w-px bg-border" />
          </>
        )}
        <div className="flex-1 min-w-0" />
        {onToggleResources && (
          <HeaderToggleButton
            icon={Folder}
            active={!!resourcesOpen}
            title={resourcesOpen ? "Hide resources" : "Show resources"}
            onClick={onToggleResources}
          />
        )}
      </div>

      <div className="flex flex-1 flex-col items-center justify-center gap-6 overflow-y-auto px-6 py-8">
        <div className="flex flex-col items-center gap-4 text-center">
          <div className="grid size-20 place-items-center rounded-2xl bg-[color:var(--accent-soft)]">
            <Film className="size-8 text-primary" strokeWidth={1.5} />
          </div>
          <h2 className="font-brand text-3xl font-semibold text-foreground">
            {firstRun ? "Welcome to libi" : "No piece open"}
          </h2>
          <p className="max-w-md text-sm text-muted-foreground">
            {firstRun
              ? "Create AI-powered video compositions. Start a piece and describe what you want to make — or ask the agent in chat for a quick tour."
              : recents.length > 0
                ? "Pick up where you left off, start something new, or ask the agent in chat."
                : "Create your first piece, or ask the agent in chat to make one for you."}
          </p>
        </div>

        <div className="flex flex-wrap items-center justify-center gap-2">
          <Button
            className="cursor-pointer"
            onClick={onCreatePiece}
            disabled={creating}
            size="lg"
            variant={firstRun ? "default" : "outline"}
          >
            <Plus className="mr-2 h-4 w-4" strokeWidth={2.2} />
            {firstRun ? "Create your first piece" : "New piece"}
          </Button>
          {showResourcesButton && (
            <Button
              className="cursor-pointer"
              onClick={onToggleResources}
              size="lg"
              variant="outline"
            >
              <PanelRight className="mr-2 h-4 w-4" strokeWidth={2.2} />
              Resources
            </Button>
          )}
        </div>

        {recents.length > 0 && (
          <div className="w-full max-w-md">
            <h3 className="mb-2 px-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Recent pieces
            </h3>
            <ul className="flex flex-col gap-1">
              {recents.map((piece) => (
                <li key={piece.id}>
                  <button
                    type="button"
                    data-testid="recent-piece-row"
                    onClick={() => onOpenPiece?.(piece.id)}
                    className="flex w-full cursor-pointer items-center gap-3 rounded-md border border-transparent px-3 py-2 text-left hover:border-border hover:bg-muted/50"
                  >
                    <Film
                      className="size-4 shrink-0 text-muted-foreground"
                      strokeWidth={1.8}
                    />
                    <span
                      data-testid="recent-piece-name"
                      className="min-w-0 flex-1 truncate text-sm text-foreground"
                    >
                      {piece.name}
                    </span>
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {piece.lastOpenedAt
                        ? `Opened ${formatRelativeTime(piece.lastOpenedAt)}`
                        : `Updated ${formatRelativeTime(piece.updatedAt)}`}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}
