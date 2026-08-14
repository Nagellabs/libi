// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { NoPieceEmptyState } from "@/components/editor/no-piece-empty-state";
import type { PieceSummary } from "@/lib/queries/pieces";

function renderState(overrides: Partial<Parameters<typeof NoPieceEmptyState>[0]> = {}) {
  const props = {
    onCreatePiece: vi.fn(),
    chatOpen: true,
    resourcesOpen: false,
    onToggleChat: vi.fn(),
    onToggleResources: vi.fn(),
    ...overrides,
  };
  render(<NoPieceEmptyState {...props} />);
  return props;
}

describe("NoPieceEmptyState", () => {
  it("renders the empty-state message and New piece button", () => {
    const props = renderState();
    expect(screen.getByText("No piece open")).toBeInTheDocument();
    const newPiece = screen.getByRole("button", { name: /new piece/i });
    fireEvent.click(newPiece);
    expect(props.onCreatePiece).toHaveBeenCalledTimes(1);
  });

  it("renders the resources toggle so a collapsed panel can be reopened", () => {
    const props = renderState({ resourcesOpen: false });
    // Same markup as EditorPanel's header toggle: title + aria-pressed.
    const resourcesToggle = screen.getByTitle("Show resources");
    expect(resourcesToggle).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(resourcesToggle);
    expect(props.onToggleResources).toHaveBeenCalledTimes(1);
  });

  it("renders the chat toggle wired to onToggleChat", () => {
    const props = renderState({ chatOpen: true });
    const chatToggle = screen.getByTitle("Hide chat");
    expect(chatToggle).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(chatToggle);
    expect(props.onToggleChat).toHaveBeenCalledTimes(1);
  });

  it("omits toggles when no handlers are provided", () => {
    renderState({ onToggleChat: undefined, onToggleResources: undefined });
    expect(screen.queryByTitle(/chat/i)).not.toBeInTheDocument();
    expect(screen.queryByTitle(/resources/i)).not.toBeInTheDocument();
  });
});

// ── Recents list + the labelled Resources button ────────────────────
//
// The panel's job is answering "what do I do now". Both additions exist to
// make that answer visible without hunting: the pieces you already have, and
// the panel they live in when you've collapsed it out of sight.

function piece(
  id: string,
  name: string,
  lastOpenedAt: string | null,
  updatedAt = "2026-01-01T00:00:00.000Z",
): PieceSummary {
  return {
    id,
    name,
    nameSetByUser: false,
    hasDraft: false,
    folderId: null,
    createdAt: updatedAt,
    updatedAt,
    lastOpenedAt,
  };
}

/** Names of the recents rows, in DOM order. */
function recentRowNames(): string[] {
  return screen
    .getAllByTestId("recent-piece-row")
    .map((row) => row.querySelector("[data-testid='recent-piece-name']")?.textContent ?? "");
}

describe("NoPieceEmptyState — recent pieces", () => {
  it("lists recents most-recently-opened first and opens the one clicked", () => {
    const onOpenPiece = vi.fn();
    renderState({
      onOpenPiece,
      pieces: [
        piece("a", "Older piece", "2026-01-01T00:00:00.000Z"),
        piece("b", "Newer piece", "2026-03-01T00:00:00.000Z"),
      ],
    });

    expect(recentRowNames()).toEqual(["Newer piece", "Older piece"]);

    fireEvent.click(screen.getByText("Older piece"));
    expect(onOpenPiece).toHaveBeenCalledWith("a");
  });

  it("shows at most five", () => {
    renderState({
      onOpenPiece: vi.fn(),
      pieces: Array.from({ length: 9 }, (_, i) =>
        piece(`p${i}`, `Piece ${i}`, `2026-01-0${i + 1}T00:00:00.000Z`),
      ),
    });
    expect(screen.getAllByText(/^Piece \d$/)).toHaveLength(5);
  });

  it("says 'Opened' only for pieces really opened, 'Updated' otherwise", () => {
    // The ordering lets never-opened pieces in (so the list is never empty on
    // an all-agent-created install); the LABEL is what keeps that honest.
    renderState({
      onOpenPiece: vi.fn(),
      pieces: [
        piece("seen", "Seen piece", "2026-03-01T00:00:00.000Z"),
        piece("unseen", "Unseen piece", null, "2026-03-02T00:00:00.000Z"),
      ],
    });
    expect(screen.getByText(/^Opened /)).toBeInTheDocument();
    expect(screen.getByText(/^Updated /)).toBeInTheDocument();
    // And exactly one of each — no row gets both, none gets neither.
    expect(screen.getAllByText(/^Opened |^Updated /)).toHaveLength(2);
  });

  it("renders no recents section at all when there are no pieces", () => {
    renderState({ onOpenPiece: vi.fn(), pieces: [] });
    expect(screen.queryByText(/recent pieces/i)).not.toBeInTheDocument();
    // ...and the copy points at creating one rather than reopening.
    expect(screen.getByText(/create your first piece/i)).toBeInTheDocument();
  });

  it("renders no recents when the page passes no open handler", () => {
    renderState({ pieces: [piece("a", "A piece", "2026-01-01T00:00:00.000Z")] });
    expect(screen.queryByText("A piece")).not.toBeInTheDocument();
  });
});

describe("NoPieceEmptyState — first run", () => {
  // A brand-new install renders THIS component rather than its own full-page
  // screen, because the onboarding (persona modal, connect-an-agent takeover,
  // demo chip) lives in the surrounding layout. A separate page swallowed all
  // three from the only user they were written for.
  it("wears the welcome headline and the create-your-first-piece label", () => {
    renderState({ firstRun: true, pieces: [], onOpenPiece: vi.fn() });
    expect(screen.getByText("Welcome to libi")).toBeInTheDocument();
    expect(screen.queryByText("No piece open")).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /create your first piece/i }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^new piece$/i })).not.toBeInTheDocument();
  });

  it("creates a piece when that button is clicked", () => {
    const props = renderState({ firstRun: true, pieces: [], onOpenPiece: vi.fn() });
    fireEvent.click(screen.getByRole("button", { name: /create your first piece/i }));
    expect(props.onCreatePiece).toHaveBeenCalledTimes(1);
  });

  it("offers no library affordances — there is no library yet", () => {
    renderState({ firstRun: true, resourcesOpen: false, pieces: [], onOpenPiece: vi.fn() });
    // No labelled Resources button: nothing to browse on a fresh install.
    expect(screen.queryByRole("button", { name: /^resources$/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/recent pieces/i)).not.toBeInTheDocument();
    // The small header toggle stays, so the panel is still reachable.
    expect(screen.getByTitle("Show resources")).toBeInTheDocument();
  });

  it("goes back to the returning-user copy once a piece exists", () => {
    renderState({
      firstRun: false,
      onOpenPiece: vi.fn(),
      pieces: [piece("a", "A piece", null)],
    });
    expect(screen.getByText("No piece open")).toBeInTheDocument();
    expect(screen.queryByText("Welcome to libi")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^new piece$/i })).toBeInTheDocument();
  });
});

describe("NoPieceEmptyState — labelled Resources button", () => {
  it("appears next to New piece while the resources panel is hidden", () => {
    const props = renderState({ resourcesOpen: false });
    const button = screen.getByRole("button", { name: /^resources$/i });
    fireEvent.click(button);
    expect(props.onToggleResources).toHaveBeenCalledTimes(1);
  });

  it("disappears once the panel is open — it would only duplicate the header toggle", () => {
    renderState({ resourcesOpen: true });
    expect(
      screen.queryByRole("button", { name: /^resources$/i }),
    ).not.toBeInTheDocument();
    // The small header toggle is still there to close it again.
    expect(screen.getByTitle("Hide resources")).toBeInTheDocument();
  });

  it("is absent when the page wires no resources handler at all", () => {
    renderState({ onToggleResources: undefined, resourcesOpen: false });
    expect(
      screen.queryByRole("button", { name: /^resources$/i }),
    ).not.toBeInTheDocument();
  });
});
