// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

type Opts = { onSuccess?: (r: { ok: true; hidden: boolean }) => void };
const report = vi.hoisted(() => vi.fn());
// The catalog view (a dev build's catalog switch) is not under test here: the build's own site's links, no view.
vi.mock("@/lib/queries/templates-catalog", async () => {
  const { LEGAL_LINKS } = await import("@/lib/legal-links");
  return { useLegalLinks: () => LEGAL_LINKS, useTemplatesCatalog: () => ({ data: undefined }) };
});
vi.mock("@/lib/queries/templates-cloud", () => ({ useReportTemplate: () => ({ mutate: report, isPending: false }) }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
import { ReportMenu, wasReported } from "@/components/templates/templates-page/report-menu";
import { LEGAL_LINKS } from "@/lib/legal-links";
import { OPENS_OUTSIDE_TEXT } from "@/components/templates/templates-page/opens-outside";

const ID = "abcdefghijklmnopqrst";

beforeEach(() => localStorage.clear());
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

async function openMenu() {
  fireEvent.click(screen.getByRole("button", { name: "Report" }));
  await waitFor(() => expect(screen.getAllByRole("menuitem").length).toBe(5));
}

describe("ReportMenu", () => {
  it("offers the five fixed reasons, confirms what a report does, and remembers it once the catalog took it", async () => {
    const { unmount } = render(<ReportMenu cloudId={ID} />);
    await openMenu();
    expect(screen.getAllByRole("menuitem").map((m) => m.textContent)).toEqual(["Spam", "Offensive", "Broken", "Copyright", "Other"]);
    fireEvent.click(screen.getByRole("menuitem", { name: "Broken" }));
    // Nothing is sent on the pick: the confirmation says what happens first.
    await waitFor(() => expect(screen.getByRole("alertdialog")).toBeInTheDocument());
    expect(report).not.toHaveBeenCalled();
    expect(screen.getByRole("alertdialog").textContent).toContain("five different people report a template within 24 hours");
    expect(screen.getByRole("alertdialog").textContent).toContain("hidden from the public catalog until it is reviewed");
    fireEvent.click(screen.getByTestId("report-confirm"));
    expect(report).toHaveBeenCalledTimes(1);
    expect(report.mock.calls[0][0]).toEqual({ cloudId: ID, reason: "broken" });
    // Not "Reported" until the catalog answers — no optimistic state.
    expect(screen.queryByText("Reported")).toBeNull();
    act(() => (report.mock.calls[0][1] as Opts).onSuccess?.({ ok: true, hidden: false }));
    expect(screen.getByText("Reported")).toBeInTheDocument();
    expect(wasReported(ID)).toBe(true);
    unmount();
    render(<ReportMenu cloudId={ID} />);
    expect(screen.getByText("Reported")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Report" })).toBeNull();
  });

  it("a report the catalog refused leaves the menu offered again, and remembers nothing", async () => {
    render(<ReportMenu cloudId={ID} />);
    await openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Spam" }));
    await waitFor(() => expect(screen.getByRole("alertdialog")).toBeInTheDocument());
    fireEvent.click(screen.getByTestId("report-confirm"));
    expect(report.mock.calls[0][0]).toEqual({ cloudId: ID, reason: "spam" });
    // The hook toasts the error; onSuccess never runs.
    expect(screen.queryByText("Reported")).toBeNull();
    expect(wasReported(ID)).toBe(false);
  });

  it("cancel sends nothing", async () => {
    render(<ReportMenu cloudId={ID} />);
    await openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Other" }));
    await waitFor(() => expect(screen.getByRole("alertdialog")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(report).not.toHaveBeenCalled();
  });

  it("offers an optional details box (≤ 2000) and sends what was typed, trimmed", async () => {
    render(<ReportMenu cloudId={ID} />);
    await openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Broken" }));
    await waitFor(() => expect(screen.getByRole("alertdialog")).toBeInTheDocument());
    const box = screen.getByLabelText("Add details (optional)");
    expect(box.tagName).toBe("TEXTAREA");
    expect(box).toHaveAttribute("maxLength", "2000");
    expect(screen.getByRole("alertdialog").textContent).toContain("Details you add go to the libi team with the report.");
    // BC review M3: a label that stays in view once typing starts (not only a placeholder), and the counter read with the box.
    const label = screen.getByText("Add details (optional)");
    expect(label.tagName).toBe("LABEL");
    expect(label).toHaveAttribute("for", box.id);
    expect(box).not.toHaveAttribute("aria-label");
    fireEvent.change(box, { target: { value: "  typed  " } });
    expect(screen.getByText("9/2000")).toBeInTheDocument();
    expect(box).toHaveAttribute("aria-describedby", screen.getByTestId("report-details-counter").id);
    expect(box).toHaveAccessibleDescription("9/2000");
    expect(label).toBeVisible();
    fireEvent.click(screen.getByTestId("report-confirm"));
    expect(report.mock.calls[0][0]).toEqual({ cloudId: ID, reason: "broken", details: "typed" });
  });

  it("an empty or blank box sends no details key", async () => {
    render(<ReportMenu cloudId={ID} />);
    await openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Spam" }));
    await waitFor(() => expect(screen.getByRole("alertdialog")).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText("Add details (optional)"), { target: { value: "   " } });
    fireEvent.click(screen.getByTestId("report-confirm"));
    expect(report.mock.calls[0][0]).toEqual({ cloudId: ID, reason: "spam" });
    expect(Object.keys(report.mock.calls[0][0])).not.toContain("details");
  });

  it("for Copyright, points a formal notice at the web form for this template, in a new tab", async () => {
    render(<ReportMenu cloudId={ID} />);
    await openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Copyright" }));
    await waitFor(() => expect(screen.getByRole("alertdialog")).toBeInTheDocument());
    expect(screen.getByRole("alertdialog").textContent).toContain("Sending a formal copyright notice? Use the web form");
    const link = screen.getByRole("link", { name: /web form/i });
    // It leaves libi, and its name says so (BC review M5).
    expect(link).toHaveAccessibleName(`Use the web form ${OPENS_OUTSIDE_TEXT}`);
    expect(link).toHaveAttribute("href", LEGAL_LINKS.templateReportForm(ID));
    expect(link.getAttribute("href")).toMatch(/\/templates\/report\?template=abcdefghijklmnopqrst$/);
    expect(link).toHaveAttribute("target", "_blank");
    expect(link.className).toContain("cursor-pointer");
  });

  it("other reasons show no web-form line", async () => {
    render(<ReportMenu cloudId={ID} />);
    await openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Offensive" }));
    await waitFor(() => expect(screen.getByRole("alertdialog")).toBeInTheDocument());
    expect(screen.queryByRole("link", { name: /web form/i })).toBeNull();
  });

  it("the details box resets when the dialog closes", async () => {
    render(<ReportMenu cloudId={ID} />);
    await openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Other" }));
    await waitFor(() => expect(screen.getByRole("alertdialog")).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText("Add details (optional)"), { target: { value: "draft" } });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    await openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Spam" }));
    await waitFor(() => expect(screen.getByRole("alertdialog")).toBeInTheDocument());
    expect(screen.getByLabelText("Add details (optional)")).toHaveValue("");
  });

  it("a corrupt memory reads as not reported", () => {
    localStorage.setItem("libi:template-reports", "{nope");
    expect(wasReported(ID)).toBe(false);
    localStorage.setItem("libi:template-reports", JSON.stringify({ [ID]: true }));
    expect(wasReported(ID)).toBe(false);
  });
});
