// @vitest-environment jsdom
// Settings → Templates → Catalog (dev builds): Production or Development, a
// development address, and an OPTIONAL, collapsed bypass token that is never
// shown back.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import type { TemplatesCatalogView } from "@/lib/templates/types";

const state = vi.hoisted(() => ({ view: undefined as unknown, isError: false, mutate: vi.fn(), isPending: false, variables: undefined as unknown }));
vi.mock("@/lib/queries/templates-catalog", () => ({
  useTemplatesCatalog: () => ({ data: state.view, isError: state.isError, refetch: vi.fn() }),
  useSetTemplatesCatalog: () => ({ mutate: state.mutate, isPending: state.isPending, variables: state.variables }),
}));
import { BYPASS_TOKEN_HINT, TemplatesCatalogCard } from "@/components/settings/templates-catalog-card";

const PROD = "https://libi.nagellabs.com";
const PREVIEW = "https://libi-site-git-templates-nagellabs.vercel.app";
const TOKEN = "AbCdEfGhIjKlMnOpQrStUvWxYz012345";
function dev(over: Partial<Extract<TemplatesCatalogView, { devBuild: true }>> = {}): TemplatesCatalogView {
  return {
    devBuild: true,
    testMode: false,
    active: { kind: "production", origin: PROD, host: "libi.nagellabs.com" },
    legalOrigin: PROD,
    choice: "production",
    production: { origin: PROD, host: "libi.nagellabs.com" },
    development: { origin: null, isDefault: false, defaultOrigin: null },
    bypassToken: { set: false, applies: false },
    ...over,
  };
}
afterEach(() => {
  cleanup();
  state.view = undefined;
  state.isError = false;
  state.isPending = false;
  state.mutate.mockReset();
});

describe("TemplatesCatalogCard", () => {
  it("loads as a skeleton, never a spinner or 'Loading…'", () => {
    render(<TemplatesCatalogCard />);
    expect(screen.getByTestId("templates-catalog-skeleton")).toBeInTheDocument();
    expect(screen.queryByText(/loading/i)).toBeNull();
  });

  it("a packaged build offers no switch", () => {
    state.view = { devBuild: false, testMode: false, active: { kind: "production", origin: PROD, host: "libi.nagellabs.com" }, legalOrigin: PROD };
    render(<TemplatesCatalogCard />);
    expect(screen.getByTestId("templates-catalog-packaged")).toHaveTextContent("libi.nagellabs.com");
    expect(screen.queryByTestId("templates-catalog-development")).toBeNull();
  });

  it("Development works with just an address: typed, then chosen — no token asked for", () => {
    state.view = dev();
    render(<TemplatesCatalogCard />);
    fireEvent.change(screen.getByTestId("templates-catalog-origin"), { target: { value: `${PREVIEW}/` } });
    fireEvent.click(screen.getByTestId("templates-catalog-development"));
    expect(state.mutate).toHaveBeenCalledWith({ choice: "development", devOrigin: PREVIEW }, expect.anything());
  });

  it("refuses a bad address inline and sends nothing", () => {
    state.view = dev();
    render(<TemplatesCatalogCard />);
    fireEvent.change(screen.getByTestId("templates-catalog-origin"), { target: { value: "http://example.com" } });
    expect(screen.getByTestId("templates-catalog-origin-problem")).toHaveTextContent(/localhost/);
    fireEvent.click(screen.getByTestId("templates-catalog-development"));
    expect(state.mutate).not.toHaveBeenCalled();
  });

  it("the token is offered only for a *.vercel.app address, collapsed, with its one-line hint", () => {
    state.view = dev({ development: { origin: "http://localhost:3300", isDefault: true, defaultOrigin: "http://localhost:3300" } });
    const { rerender } = render(<TemplatesCatalogCard />);
    expect(screen.queryByTestId("templates-catalog-token")).toBeNull();
    state.view = dev({ development: { origin: PREVIEW, isDefault: false, defaultOrigin: null } });
    rerender(<TemplatesCatalogCard />);
    expect(screen.getByTestId("templates-catalog-token-toggle")).toHaveTextContent("optional");
    expect(screen.queryByTestId("templates-catalog-token-input")).toBeNull();
    fireEvent.click(screen.getByTestId("templates-catalog-token-toggle"));
    expect(screen.getByText(new RegExp(BYPASS_TOKEN_HINT.replace(/\./g, "\\.")))).toBeInTheDocument();
    expect(BYPASS_TOKEN_HINT).toBe("Only needed if Deployment Protection is on.");
    expect(screen.getByTestId("templates-catalog-token-input")).toHaveAttribute("type", "password");
  });

  it("sets, replaces and clears the token — and never shows it back", () => {
    state.view = dev({ choice: "development", development: { origin: PREVIEW, isDefault: false, defaultOrigin: null } });
    state.mutate.mockImplementation((_change: unknown, opts?: { onSuccess?: () => void }) => opts?.onSuccess?.());
    const { rerender } = render(<TemplatesCatalogCard />);
    fireEvent.click(screen.getByTestId("templates-catalog-token-toggle"));
    expect(screen.getByTestId("templates-catalog-token-save")).toHaveTextContent("Set");
    fireEvent.change(screen.getByTestId("templates-catalog-token-input"), { target: { value: ` ${TOKEN} ` } });
    fireEvent.click(screen.getByTestId("templates-catalog-token-save"));
    expect(state.mutate).toHaveBeenCalledWith({ bypassToken: TOKEN }, expect.anything());
    // Sent once, then gone from the field.
    expect(screen.getByTestId("templates-catalog-token-input")).toHaveValue("");
    state.view = dev({ choice: "development", development: { origin: PREVIEW, isDefault: false, defaultOrigin: null }, bypassToken: { set: true, applies: true } });
    rerender(<TemplatesCatalogCard />);
    expect(screen.getByTestId("templates-catalog-token-save")).toHaveTextContent("Replace");
    fireEvent.click(screen.getByTestId("templates-catalog-token-clear"));
    expect(state.mutate).toHaveBeenLastCalledWith({ bypassToken: null }, expect.anything());
    expect(document.body.innerHTML).not.toContain(TOKEN.slice(4));
  });

  // Review M11: one creator key serves both catalogs, so a development address that is not this
  // machine receives it. Said under the address, where the address is typed.
  it("says the creator key goes to a development site that isn't this machine — stored or typed", () => {
    const NOTE = "Your creator key is sent to this site.";
    state.view = dev({ development: { origin: "https://x.vercel.app", isDefault: false, defaultOrigin: null } });
    const { rerender } = render(<TemplatesCatalogCard />);
    expect(screen.getByTestId("templates-catalog-key-note")).toHaveTextContent(NOTE);
    state.view = dev({ development: { origin: "http://localhost:3300", isDefault: false, defaultOrigin: null } });
    rerender(<TemplatesCatalogCard />);
    expect(screen.queryByTestId("templates-catalog-key-note")).toBeNull();
    expect(screen.queryByText(NOTE)).toBeNull();
    fireEvent.change(screen.getByTestId("templates-catalog-origin"), { target: { value: "http://127.0.0.1:3300" } });
    expect(screen.queryByTestId("templates-catalog-key-note")).toBeNull();
    fireEvent.change(screen.getByTestId("templates-catalog-origin"), { target: { value: "https://x.vercel.app" } });
    expect(screen.getByTestId("templates-catalog-key-note")).toHaveTextContent(NOTE);
    // No address, or one that isn't valid: nothing to say it about.
    fireEvent.change(screen.getByTestId("templates-catalog-origin"), { target: { value: "" } });
    expect(screen.queryByTestId("templates-catalog-key-note")).toBeNull();
    fireEvent.change(screen.getByTestId("templates-catalog-origin"), { target: { value: "http://example.com" } });
    expect(screen.queryByTestId("templates-catalog-key-note")).toBeNull();
  });

  it("every interactive element has cursor-pointer", () => {
    state.view = dev({ development: { origin: PREVIEW, isDefault: false, defaultOrigin: null }, bypassToken: { set: true, applies: true } });
    render(<TemplatesCatalogCard />);
    fireEvent.click(screen.getByTestId("templates-catalog-token-toggle"));
    for (const el of screen.getAllByRole("button")) expect(el.className, el.textContent ?? "").toContain("cursor-pointer");
  });
});
