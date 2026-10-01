// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import SessionContextMenu from "@/components/sessions/session-context-menu";

/**
 * The chat session's right-click menu. "Restart session" sits directly BELOW "Copy session ID",
 * and only where a restart can apply — the caller passes `onRestart` for an agent chat (Claude
 * Code, Codex) and nothing otherwise.
 */
const state = { x: 10, y: 10, sessionId: "s1" };

describe("SessionContextMenu", () => {
  it("puts Restart session directly below Copy session ID", () => {
    render(<SessionContextMenu state={state} onCopyId={vi.fn()} onRestart={vi.fn()} />);
    const items = screen.getAllByRole("menuitem").map((b) => b.textContent);
    expect(items).toEqual(["Copy session ID", "Restart session"]);
  });

  it("offers no Restart where it cannot apply", () => {
    render(<SessionContextMenu state={state} onCopyId={vi.fn()} />);
    expect(screen.getAllByRole("menuitem").map((b) => b.textContent)).toEqual(["Copy session ID"]);
  });

  it("runs the restart on click, with a pointer cursor and an icon like the others", () => {
    const onRestart = vi.fn();
    render(<SessionContextMenu state={state} onCopyId={vi.fn()} onRestart={onRestart} />);
    const item = screen.getByRole("menuitem", { name: "Restart session" });
    expect(item).toHaveClass("cursor-pointer");
    expect(item.querySelector("svg")).not.toBeNull();
    fireEvent.click(item);
    expect(onRestart).toHaveBeenCalledOnce();
  });

  it("names the wait while this chat is already restarting, and cannot be clicked again", () => {
    const onRestart = vi.fn();
    render(<SessionContextMenu state={state} onCopyId={vi.fn()} onRestart={onRestart} restarting />);
    const item = screen.getByRole("menuitem", { name: "Restarting…" });
    expect(item).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(item);
    expect(onRestart).not.toHaveBeenCalled();
  });

  it("offers Remove from list only when asked to (a chat whose history is gone), and runs it on click", () => {
    const onRemove = vi.fn();
    render(<SessionContextMenu state={state} onCopyId={vi.fn()} onRemove={onRemove} />);
    expect(screen.getAllByRole("menuitem").map((b) => b.textContent)).toEqual(["Copy session ID", "Remove from list"]);
    const item = screen.getByRole("menuitem", { name: "Remove from list" });
    expect(item).toHaveClass("cursor-pointer");
    expect(item.querySelector("svg")).not.toBeNull();
    fireEvent.click(item);
    expect(onRemove).toHaveBeenCalledOnce();
  });
});
