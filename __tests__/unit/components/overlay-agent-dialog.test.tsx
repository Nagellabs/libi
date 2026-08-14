// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { OverlayAgentDialog } from "@/components/preview/overlay-agent-dialog";

beforeEach(() => {
  global.fetch = vi.fn(
    async () => new Response(JSON.stringify({ sessionId: "s1" }), { status: 200 }),
  ) as never;
});

describe("OverlayAgentDialog", () => {
  it("seeds the textarea and sends the edited prompt", async () => {
    const switchSession = vi.fn();
    render(
      <OverlayAgentDialog
        open
        onOpenChange={() => {}}
        initialPrompt="Create a 3D overlay"
        sessionList={{ switchSession, refresh: () => {} }}
        chatVisible
        toggleChat={() => {}}
      />,
    );
    const ta = screen.getByRole("textbox") as HTMLTextAreaElement;
    expect(ta.value).toContain("Create a 3D overlay");
    fireEvent.click(screen.getByText(/Send/));
    await waitFor(() =>
      expect(global.fetch).toHaveBeenCalledWith(
        "/api/agent/dispatch",
        expect.objectContaining({ method: "POST" }),
      ),
    );
  });

  it("Send disabled when empty", () => {
    render(
      <OverlayAgentDialog
        open
        onOpenChange={() => {}}
        initialPrompt=""
        sessionList={{ switchSession: () => {}, refresh: () => {} }}
        chatVisible
        toggleChat={() => {}}
      />,
    );
    expect(screen.getByText(/Send/).closest("button")).toBeDisabled();
  });
});
