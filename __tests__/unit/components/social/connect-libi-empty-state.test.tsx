// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import React from "react";
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ConnectLibiEmptyState } from "@/components/social/connect-libi-empty-state";

const wrap = (ui: React.ReactElement) =>
  render(<QueryClientProvider client={new QueryClient()}>{ui}</QueryClientProvider>);

describe("ConnectLibiEmptyState", () => {
  it("distinguishes libi's view from the agent's ability to post", () => {
    wrap(<ConnectLibiEmptyState variant="never" />);
    expect(screen.getByText("Connect libi to Zernio to see your posts here.")).toBeInTheDocument();
    expect(
      screen.getByText(
        /This is libi's own view of your Zernio account\. Your agent's connection is separate and still works — it can post right now, this page just can't show you anything until libi is connected\./,
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Connect libi" })).toHaveClass("cursor-pointer");
  });

  it("revoked variant", () => {
    wrap(<ConnectLibiEmptyState variant="revoked" />);
    expect(screen.getByText("libi's connection was revoked. Your agent's connection is unaffected.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reconnect libi" })).toBeInTheDocument();
  });
});
