// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import React from "react";
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { StatusChip, TargetChips } from "@/components/social/status-chips";
import type { SocialTarget } from "@/lib/social/types";

const inbox: SocialTarget = { platform: "tiktok", accountId: "t", status: "published", delivery: "inbox" };
const live: SocialTarget = { platform: "instagram", accountId: "i", status: "published", url: "https://instagram.com/p/1" };

describe("status chips speak libi's words", () => {
  it("an inbox upload reads 'Sent to inbox', never 'Published'", () => {
    render(<StatusChip post={{ status: "published", targets: [inbox] }} />);
    expect(screen.getByTestId("status-chip")).toHaveTextContent("Sent to inbox");
    expect(screen.getByTestId("status-chip")).toHaveAttribute("data-status", "inbox");
    expect(screen.queryByText("Published")).toBeNull();
  });

  it("a real publish still reads Published, and a draft Draft", () => {
    const { rerender } = render(<StatusChip post={{ status: "published", targets: [live] }} />);
    expect(screen.getByTestId("status-chip")).toHaveTextContent("Published");
    rerender(<StatusChip post={{ status: "draft", targets: [{ ...live, status: "pending" }] }} />);
    expect(screen.getByTestId("status-chip")).toHaveTextContent("Draft");
  });

  it("per-target chips differ for the same published post", () => {
    render(<TargetChips targets={[inbox, live]} />);
    expect(screen.getAllByTestId("target-chip").map((c) => c.textContent)).toEqual(["Sent to inbox", "Published"]);
  });
});
