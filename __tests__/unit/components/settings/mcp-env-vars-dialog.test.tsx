// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

const mutate = vi.fn();
vi.mock("@/lib/queries/mcp-servers", () => ({
  useUpdateMcpServer: () => ({ mutate, isPending: false }),
}));

import { McpEnvVarsDialog } from "@/components/settings/mcp-env-vars-dialog";
import type { McpServerUI } from "@/lib/queries/mcp-servers";

/**
 * RC-F: the dialog blanks its fields each time it OPENS (render-time reset
 * keyed on open + server.id) — a reopened dialog must never show the previous
 * session's typed secrets, and blank fields are omitted from the save.
 */

const server = {
  id: "srv1",
  name: "fal-ai",
  configuredEnvVars: ["FAL_KEY"],
} as unknown as McpServerUI;

function renderDialog(open: boolean) {
  return render(
    <McpEnvVarsDialog
      open={open}
      onOpenChange={() => {}}
      server={server}
      requiredEnvVars={["FAL_KEY", "OTHER_KEY"]}
    />,
  );
}

describe("McpEnvVarsDialog", () => {
  it("starts blank and only sends the keys the user typed", () => {
    renderDialog(true);
    const other = screen.getByLabelText(/OTHER_KEY/);
    fireEvent.change(other, { target: { value: "secret-value" } });
    fireEvent.click(screen.getByRole("button", { name: /save/i }));
    expect(mutate).toHaveBeenCalledWith(
      { id: "srv1", envVars: { OTHER_KEY: "secret-value" } },
      expect.anything(),
    );
  });

  it("blanks typed values when the dialog is closed and reopened", () => {
    const view = renderDialog(true);
    const other = screen.getByLabelText(/OTHER_KEY/) as HTMLInputElement;
    fireEvent.change(other, { target: { value: "typed-secret" } });
    expect(other.value).toBe("typed-secret");

    view.rerender(
      <McpEnvVarsDialog
        open={false}
        onOpenChange={() => {}}
        server={server}
        requiredEnvVars={["FAL_KEY", "OTHER_KEY"]}
      />,
    );
    view.rerender(
      <McpEnvVarsDialog
        open={true}
        onOpenChange={() => {}}
        server={server}
        requiredEnvVars={["FAL_KEY", "OTHER_KEY"]}
      />,
    );
    expect((screen.getByLabelText(/OTHER_KEY/) as HTMLInputElement).value).toBe("");
  });
});
