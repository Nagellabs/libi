// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { OverlayPresetDialog } from "@/components/preview/overlay-preset-dialog";
import type { TextOverlay } from "@/lib/engine/types";

const overlay = { id: "ov1", kind: "text", content: "Hi", rect: { x:0,y:0,w:.5,h:.2 }, startTime:0, duration:2, z:0, color:"#fff" } as unknown as TextOverlay;

function wrap(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

beforeEach(() => {
  global.fetch = vi.fn(async (url: string, init?: RequestInit) => {
    const u = String(url);
    if (u.startsWith("/api/overlay-presets") && (!init || init.method === undefined || init.method === "GET")) {
      return new Response(JSON.stringify({ presets: [
        { id: "my-look", name: "My Look", kind: "text", source: "user", fields: {}, createdAt: "2026-06-20T10:00:00.000Z", updatedAt: "2026-06-25T10:00:00.000Z" },
        { id: "neon-code", name: "Neon Code", kind: "code", source: "user", fields: {}, createdAt: "2026-06-22T10:00:00.000Z", updatedAt: "2026-06-25T12:00:00.000Z" },
      ] }), { status: 200 });
    }
    if (u === "/api/overlay-presets" && init?.method === "POST") {
      const body = JSON.parse(init.body as string);
      if (body.name === "My Look" && !body.override) {
        return new Response(JSON.stringify({ error: "preset_name_exists", presetId: "my-look", name: "My Look" }), { status: 409 });
      }
      return new Response(JSON.stringify({ presetId: "saved" }), { status: 200 });
    }
    if (u.includes("/apply-preset")) return new Response(JSON.stringify({ success: true }), { status: 200 });
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("OverlayPresetDialog", () => {
  it("lists existing same-kind user presets", async () => {
    wrap(<OverlayPresetDialog pieceId="p1" overlay={overlay} open onOpenChange={() => {}} />);
    expect(await screen.findByText("My Look")).toBeInTheDocument();
  });

  it("saving a taken name shows a replace confirm, then saves with override", async () => {
    wrap(<OverlayPresetDialog pieceId="p1" overlay={overlay} open onOpenChange={() => {}} />);
    fireEvent.change(screen.getByPlaceholderText(/preset name/i), { target: { value: "My Look" } });
    fireEvent.click(screen.getByRole("button", { name: /^save/i }));
    expect(await screen.findByText(/replace/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /replace/i }));
    await waitFor(() => {
      const calls = (global.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls;
      const override = calls.some(([, init]) => init && (init as RequestInit).method === "POST" && JSON.parse((init as RequestInit).body as string).override === true);
      expect(override).toBe(true);
    });
  });

  it("clicking a same-kind preset row applies it onto the overlay", async () => {
    const onOpenChange = vi.fn();
    wrap(<OverlayPresetDialog pieceId="p1" overlay={overlay} open onOpenChange={onOpenChange} />);
    fireEvent.click(await screen.findByText("My Look"));
    await waitFor(() => {
      const calls = (global.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls;
      expect(calls.some(([u]) => String(u).includes("/apply-preset"))).toBe(true);
    });
  });

  it("shows a DIFFERENT-kind preset disabled — cannot be applied to this layer", async () => {
    wrap(<OverlayPresetDialog pieceId="p1" overlay={overlay} open onOpenChange={() => {}} />);
    // The code preset is listed (organized by type) but its apply button is
    // aria-disabled on a text layer.
    await screen.findByText("Neon Code");
    const codeApply = document.querySelector('[data-preset-id="neon-code"] button') as HTMLButtonElement;
    expect(codeApply.getAttribute("aria-disabled")).toBe("true");
    expect(codeApply.getAttribute("title")).toMatch(/can't be applied/i);
    // The same-kind one is enabled.
    const textApply = document.querySelector('[data-preset-id="my-look"] button') as HTMLButtonElement;
    expect(textApply.getAttribute("aria-disabled")).toBe("false");
    // Clicking the disabled (mismatched) preset does NOT apply anything.
    fireEvent.click(codeApply);
    const calls = (global.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    expect(calls.some(([u]) => String(u).includes("/apply-preset"))).toBe(false);
  });

  it("offers a per-type filter that narrows the list by overlay kind", async () => {
    wrap(<OverlayPresetDialog pieceId="p1" overlay={overlay} open onOpenChange={() => {}} />);
    await screen.findByText("My Look");
    expect(screen.getByTestId("preset-kind-filter")).toBeInTheDocument();
    // Filter to Code → the text preset drops out, the code one remains.
    fireEvent.click(screen.getByRole("button", { name: "Code" }));
    await waitFor(() => {
      expect(screen.queryByText("My Look")).toBeNull();
      expect(screen.getByText("Neon Code")).toBeInTheDocument();
    });
  });

  it("sorts the list by last update time (newest first)", async () => {
    wrap(<OverlayPresetDialog pieceId="p1" overlay={overlay} open onOpenChange={() => {}} />);
    await screen.findByText("My Look");
    const rows = Array.from(document.querySelectorAll("[data-preset-id]"));
    // neon-code updated 12:00 > my-look 10:00 → it sorts first regardless of kind.
    expect(rows.map((r) => r.getAttribute("data-preset-id"))).toEqual(["neon-code", "my-look"]);
  });

  it("deleting a preset requires a confirmation step", async () => {
    wrap(<OverlayPresetDialog pieceId="p1" overlay={overlay} open onOpenChange={() => {}} />);
    await screen.findByText("My Look");
    const row = document.querySelector('[data-preset-id="my-look"]') as HTMLElement;

    const deleteFired = () =>
      (global.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls.some(
        ([u, init]) =>
          String(u).includes("/api/overlay-presets/my-look") &&
          (init as RequestInit | undefined)?.method === "DELETE",
      );

    // Click the row's Delete button → a confirm appears; nothing deleted yet.
    fireEvent.click(screen.getByRole("button", { name: "Delete preset My Look" }));
    expect(within(row).getByText(/delete forever/i)).toBeInTheDocument();
    expect(deleteFired()).toBe(false);

    // Confirm → the DELETE actually fires.
    fireEvent.click(within(row).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(deleteFired()).toBe(true));
  });
});
