// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import type { MineTemplate } from "@/lib/templates/cloud/client";
import type { TemplateSummary } from "@/lib/templates/types";

const mine = vi.hoisted(() => ({ current: { data: undefined as unknown, isPending: true, isError: false } }));
const setHidden = vi.hoisted(() => vi.fn());
// The catalog view (a dev build's catalog switch) is not under test here: the build's own site's links, no view.
vi.mock("@/lib/queries/templates-catalog", async () => {
  const { LEGAL_LINKS } = await import("@/lib/legal-links");
  return { useLegalLinks: () => LEGAL_LINKS, useTemplatesCatalog: () => ({ data: undefined }) };
});
vi.mock("@/lib/queries/templates-cloud", () => ({
  useCloudMine: () => mine.current,
  useSetTemplateHidden: () => ({ mutate: setHidden, isPending: false }),
}));
import { TemplatesTable } from "@/components/templates/templates-page/templates-table";
import { UsesSparkline } from "@/components/templates/templates-page/uses-sparkline";

const PUB = "aaaaaaaaaaaaaaaaaaaa";
const MOD = "bbbbbbbbbbbbbbbbbbbb";
const ELSEWHERE = "cccccccccccccccccccc";
const INSTALLED = "dddddddddddddddddddd";

function local(over: Partial<TemplateSummary>): TemplateSummary {
  return {
    id: "t1", cloudId: null, name: "Local one", description: "", tags: [], origin: "local", version: 1, hasCode: false, slots: [], slotCount: 0,
    canvas: { width: 1080, height: 1920, fps: 30 }, duration: 3, usesTotal: 2, uses7d: 1, lastUsedAt: null,
    createdAt: "2026-09-23T00:00:00.000Z", updatedAt: "2026-09-23T00:00:00.000Z", hasPoster: false, hasExample: false,
    poster: null, video: null, nickname: null, broken: null, otherCatalog: null, mediaRev: 0, canRenderExample: false, sourcePieceName: null, sourceEmpty: false, ...over,
  };
}
function cloud(over: Partial<MineTemplate>): MineTemplate {
  return {
    id: PUB, name: "Published", version: 1, hidden: false, moderated: false, indexPending: false, usesTotal: 40, uses7d: 9,
    byDay: { "20260923": 3 }, createdAt: "2026-09-23T00:00:00.000Z", updatedAt: "2026-09-23T00:00:00.000Z", ...over,
  };
}
const ROWS = [
  local({}),
  local({ id: "t2", cloudId: PUB, name: "Published" }),
  local({ id: "t3", cloudId: MOD, name: "Moderated" }),
  local({ id: "t4", cloudId: INSTALLED, name: "‮stranger", origin: "installed" }),
];
const row = (testId: string, value: string) => screen.getAllByTestId("templates-table-row").find((r) => r.getAttribute(testId) === value)!;

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("TemplatesTable — the /mine join", () => {
  it("shows the catalog's numbers, a sparkline and the visibility control for published rows; Installed for installed ones", () => {
    mine.current = {
      isPending: false, isError: false,
      data: { nickname: "n", templates: [cloud({}), cloud({ id: MOD, name: "Moderated", hidden: true, moderated: true }), cloud({ id: ELSEWHERE, name: "From my laptop", hidden: true, indexPending: true })] },
    };
    render(<TemplatesTable rows={ROWS} />);
    const pub = row("data-template-id", "t2");
    expect(within(pub).getByText("9")).toBeInTheDocument();
    expect(within(pub).getByText("40")).toBeInTheDocument();
    expect(within(pub).getByTestId("uses-sparkline")).toBeInTheDocument();
    fireEvent.click(within(pub).getByRole("button", { name: "Hide" }));
    expect(setHidden).toHaveBeenCalledWith({ cloudId: PUB, hidden: true });

    const mod = row("data-template-id", "t3");
    expect(within(mod).getByText("Hidden by moderation")).toBeInTheDocument();
    expect(within(mod).queryByRole("button")).toBeNull();

    const inst = row("data-template-id", "t4");
    expect(within(inst).getByTestId("templates-table-installed")).toBeInTheDocument();
    expect(within(inst).queryByTestId("uses-sparkline")).toBeNull();
    expect(inst.querySelector("bdi")?.textContent).toBe("‮stranger");

    const loc = row("data-template-id", "t1");
    expect(within(loc).getByText("Local")).toBeInTheDocument();
    expect(within(loc).getByText("2")).toBeInTheDocument();

    // Published under this key but not on this machine: still listed, still hideable again.
    const away = row("data-cloud-id", ELSEWHERE);
    expect(within(away).getByTestId("templates-table-not-here")).toBeInTheDocument();
    fireEvent.click(within(away).getByRole("button", { name: "Hide again" }));
    expect(setHidden).toHaveBeenLastCalledWith({ cloudId: ELSEWHERE, hidden: true });
    expect(screen.queryByTestId("templates-table-mine-offline")).toBeNull();
  });

  it("a catalog install of the creator's own template joins its /mine entry instead of listing it twice", () => {
    const OWN = "eeeeeeeeeeeeeeeeeeee";
    mine.current = { isPending: false, isError: false, data: { nickname: "n", templates: [cloud({ id: OWN, name: "Mine, installed back" })] } };
    render(<TemplatesTable rows={[local({ id: "t5", cloudId: OWN, name: "Mine, installed back", origin: "installed" })]} />);
    expect(screen.getAllByTestId("templates-table-row")).toHaveLength(1);
    const own = row("data-template-id", "t5");
    expect(own.getAttribute("data-cloud-id")).toBe(OWN);
    expect(within(own).getByRole("button", { name: "Hide" })).toBeInTheDocument();
    expect(within(own).queryByTestId("templates-table-not-here")).toBeNull();
  });

  it("offline, published rows keep this machine's numbers and the table says why", () => {
    mine.current = { isPending: false, isError: false, data: { nickname: null, templates: [], error: "offline" } };
    render(<TemplatesTable rows={ROWS} />);
    expect(screen.getByTestId("templates-table-mine-offline")).toBeInTheDocument();
    const pub = row("data-template-id", "t2");
    expect(within(pub).getByTestId("templates-table-published")).toBeInTheDocument();
    expect(within(pub).getByText("2")).toBeInTheDocument();
    expect(within(pub).queryByRole("button")).toBeNull();
    // The route's error text is never shown.
    expect(screen.queryByText(/offline/)).toBeNull();
  });

  // A11 fix round 1: "can't reach" only when nothing answered.
  it("says why the catalog's side is missing by the route's code — 'can't reach' only when nothing answered", () => {
    const note = (error: string | undefined, isError = false) => {
      cleanup();
      mine.current = { isPending: false, isError, data: isError ? undefined : { nickname: null, templates: [], error } };
      render(<TemplatesTable rows={ROWS} />);
      return screen.getByTestId("templates-table-mine-offline").textContent ?? "";
    };
    expect(note("unreachable")).toMatch(/Can.t reach the catalog/);
    expect(note("unauthorized")).toMatch(/didn.t accept this install.s creator key/);
    expect(note("unavailable")).toMatch(/couldn.t list your published templates/);
    for (const text of [note("unauthorized"), note("unavailable"), note(undefined, true)]) expect(text).not.toMatch(/reach/);
  });

  // A11 fix round 1: a stranger's name (an installed row) is text in the cell, not a tooltip.
  it("puts no template name in a title attribute", () => {
    mine.current = { isPending: false, isError: false, data: { nickname: "n", templates: [cloud({ id: ELSEWHERE, name: "From my laptop" })] } };
    const { container } = render(<TemplatesTable rows={ROWS} />);
    expect(container.querySelectorAll("[title]")).toHaveLength(0);
  });
});

describe("UsesSparkline", () => {
  it("plots 30 UTC days ending today, reading dashed and undashed keys alike", () => {
    const now = Date.parse("2026-09-23T12:00:00.000Z");
    render(<UsesSparkline byDay={{ "20260923": 2, "2026-09-22": 1, "20260101": 50 }} now={now} />);
    const svg = screen.getByTestId("uses-sparkline");
    expect(svg.getAttribute("aria-label")).toBe("3 uses in the last 30 days");
    const pts = svg.querySelector("polyline")!.getAttribute("points")!.split(" ");
    expect(pts).toHaveLength(30);
    expect(pts[29]).toBe("100,1");
    expect(pts[0]).toBe("0,19");
  });
});

describe("TemplatesTable — a row linked to another catalog", () => {
  it("shows it as local or installed, with a note naming the test-mode catalog (or another one)", () => {
    mine.current = { isPending: false, isError: false, data: { nickname: "n", templates: [] } };
    render(
      <TemplatesTable
        rows={[
          local({ id: "fx-local", name: "Published in test mode", otherCatalog: "test-mode" }),
          local({ id: "fx-inst", name: "Installed in test mode", origin: "installed", otherCatalog: "test-mode" }),
          local({ id: "real", name: "Published for real", otherCatalog: "https://libi.nagellabs.com" }),
        ]}
      />,
    );
    const fxLocal = row("data-template-id", "fx-local");
    expect(within(fxLocal).getByText("Local")).toBeInTheDocument();
    expect(within(fxLocal).getByTestId("templates-table-other-catalog")).toHaveTextContent("From the test-mode catalog");
    const fxInst = row("data-template-id", "fx-inst");
    expect(within(fxInst).getByTestId("templates-table-installed")).toBeInTheDocument();
    expect(within(fxInst).getByTestId("templates-table-other-catalog")).toHaveTextContent("From the test-mode catalog");
    expect(within(row("data-template-id", "real")).getByTestId("templates-table-other-catalog")).toHaveTextContent("From the production catalog");
  });
});

describe("otherCatalogLabel", () => {
  it("names test mode, production, and a dev build's development catalog by host", async () => {
    const { otherCatalogLabel } = await import("@/components/templates/templates-page/templates-table");
    expect(otherCatalogLabel("test-mode")).toBe("From the test-mode catalog");
    expect(otherCatalogLabel("https://libi.nagellabs.com")).toBe("From the production catalog");
    expect(otherCatalogLabel("http://localhost:3300")).toBe("From the development catalog (localhost:3300)");
  });
});
