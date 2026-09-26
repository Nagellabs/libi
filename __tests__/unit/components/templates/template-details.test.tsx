// @vitest-environment jsdom
//
// D6: a template's own page — the local one (/templates/<id>) and a public
// catalog entry's (/templates/public/<cloudId>). The hooks are real; only the
// routes they call are stubbed, so the page is tested through the same data
// path it runs on.
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { makeScaffold } from "@/__tests__/helpers/templates";
import type { TemplateSummary } from "@/lib/templates/types";

const push = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => "/templates/t1",
  useSearchParams: () => new URLSearchParams(""),
}));
const openWith = vi.hoisted(() => vi.fn());
vi.mock("@/hooks/agent/use-dispatch-to-agent", () => ({
  useDispatchToAgent: () => ({ openWith, open: false, prompt: "", setOpen: vi.fn(), sending: false, send: vi.fn(), copy: vi.fn() }),
}));
vi.mock("@/components/agent/dispatch-to-agent-dialog", () => ({ DispatchToAgentDialog: () => null }));

import { DetailsSkeleton } from "@/components/templates/template-details/details-skeleton";
import { LocalTemplateDetails } from "@/components/templates/template-details/local-template-details";
import { PublicTemplateDetails } from "@/components/templates/template-details/public-template-details";
import { __resetPublicDetailBackoffForTests } from "@/lib/queries/templates-cloud";

const CLOUD = "abcdefghijklmnopqrst";
const BASE = "https://storage.googleapis.com/libi-prod-templates/";
const rect = { x: 0, y: 0, width: 10, height: 10 };

function scaffold() {
  return makeScaffold({
    slots: [
      { key: "headline", kind: "text", label: "Headline", required: true },
      { key: "hero", kind: "video", label: "Hero", required: true },
    ],
    overlays: [
      { key: "headline", kind: "text", displayName: "Headline", rect, startTime: 0, duration: 3, z: 1, opacity: 1, text: { slot: "headline" }, font: "bold 72px Inter", color: "#fff", align: "center" },
      { key: "hero", kind: "video", rect, startTime: 0, duration: 3, z: 0, opacity: 1, source: { slot: "hero" } },
      { key: "logo", kind: "image", displayName: "Logo", rect, startTime: 0.5, duration: 2, z: 4, opacity: 1, source: { assetRef: "logo" } },
    ],
    assets: [
      { ref: "logo", kind: "image", file: "assets/logo.png", bytes: 2048 },
      { ref: "bed", kind: "audio", file: "assets/bed.mp3" },
      { ref: "clip", kind: "video", url: "https://cdn.example.com/clip.mp4" },
      { ref: "brand", kind: "font", file: "assets/Brand.ttf", bytes: 9000 },
    ],
  });
}

function summary(over: Partial<TemplateSummary> = {}): TemplateSummary {
  return {
    id: "t1", cloudId: null, name: "Lower third", description: "A name card.", tags: ["promo", "intro"], origin: "local", version: 2, hasCode: true,
    slots: [], slotCount: 2, canvas: { width: 1080, height: 1920, fps: 30 }, duration: 3.5, usesTotal: 3, uses7d: 2, lastUsedAt: null,
    createdAt: "2026-09-23T00:00:00.000Z", updatedAt: "2026-09-23T00:00:00.000Z", hasPoster: true, hasExample: true,
    poster: "/api/templates/t1/media/poster.jpg", video: "/api/templates/t1/media/example.mp4", nickname: null, broken: null, otherCatalog: null,
    mediaRev: 7, canRenderExample: true, sourcePieceName: "Source piece",
    ...over,
  } as TemplateSummary;
}

type Route = (url: string, init?: RequestInit) => { status: number; body: unknown; headers?: Record<string, string> } | undefined;
let routes: Route[] = [];
/** Every URL the page fetched, in order. */
let fetched: string[] = [];
function json(status: number, body: unknown, headers: Record<string, string> = {}) {
  return Promise.resolve({ ok: status >= 200 && status < 300, status, headers: new Headers(headers), json: async () => body } as Response);
}
function stubFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: string, init?: RequestInit) => {
      const url = String(input);
      fetched.push(url);
      for (const r of routes) {
        const hit = r(url, init);
        if (hit) return json(hit.status, hit.body, hit.headers);
      }
      if (url === "/api/templates/cloud/mine") return json(200, { nickname: null, templates: [] });
      if (url === "/api/templates/examples/rendering") return json(200, { templateIds: [] });
      return Promise.reject(new Error(`unexpected fetch ${url}`));
    }),
  );
}

function mount(node: React.ReactNode, client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })) {
  return { client, ...render(<QueryClientProvider client={client}>{node}</QueryClientProvider>) };
}

const localDetail = (over: Partial<TemplateSummary> = {}, extra: Record<string, unknown> = {}) => ({
  template: summary(over),
  scaffold: scaffold(),
  instructions: "# Purpose\n",
  usage: { total: 3, d7: 2, d30: 3, lastUsedAt: new Date(Date.now() - 3 * 86_400_000).toISOString() },
  ...extra,
});

function mineEntry(over: Record<string, unknown> = {}) {
  return {
    id: CLOUD, name: "Lower third", version: 1, hidden: false, moderated: false, indexPending: false, usesTotal: 40, uses7d: 6,
    byDay: { [new Date().toISOString().slice(0, 10).replace(/-/g, "")]: 6, "2026-01-01": 34 }, createdAt: "2026-09-23T00:00:00.000Z", updatedAt: "2026-09-23T00:00:00.000Z",
    moderation: null, ...over,
  };
}

function cloudDoc(over: Record<string, unknown> = {}) {
  return {
    id: CLOUD, name: "Hook + caption", description: "Three seconds.", tags: ["hook"], nickname: "nadav", authorId: "a", version: 3, hasCode: false,
    canvas: { width: 1080, height: 1920 }, duration: 3, slotCount: 2, poster: `templates/${CLOUD}/v3/poster.jpg`, video: `templates/${CLOUD}/v3/example.mp4`,
    usesTotal: 12, uses7d: 4, createdAt: "2026-09-23T00:00:00.000Z", updatedAt: "2026-09-23T00:00:00.000Z",
    files: [], prefix: `templates/${CLOUD}/v3/`, base: BASE, example: { durationSec: 3, width: 1080, height: 1920 },
    ...over,
  };
}
const publicDetail = (over: Record<string, unknown> = {}, docOver: Record<string, unknown> = {}) => ({
  template: cloudDoc(docOver),
  scaffold: scaffold(),
  mediaBase: `${BASE}templates/${CLOUD}/v3/`,
  installedTemplateId: null,
  installedOrigin: null,
  droppedAssets: 0,
  ...over,
});

/** Every button and link on the page carries cursor-pointer. */
function expectPointerEverywhere(root: HTMLElement) {
  const clickables = [...root.querySelectorAll("button, a")];
  expect(clickables.length).toBeGreaterThan(0);
  for (const el of clickables) expect(el.className, el.outerHTML.slice(0, 120)).toMatch(/cursor-(pointer|zoom-in)/);
}

beforeEach(() => {
  routes = [];
  fetched = [];
  __resetPublicDetailBackoffForTests();
  push.mockReset();
  openWith.mockReset();
  stubFetch();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("LocalTemplateDetails", () => {
  beforeEach(() => {
    routes.push((url) => (url === "/api/templates/t1" ? { status: 200, body: localDetail() } : undefined));
  });

  it("renders the name, canvas, duration, code badge, a playable video with sound, and Use / Edit / Delete", async () => {
    const { container } = mount(<LocalTemplateDetails id="t1" />);
    expect(await screen.findByRole("heading", { level: 1, name: "Lower third" })).toBeInTheDocument();
    expect(screen.getByText("A name card.")).toBeInTheDocument();
    expect(screen.getByTestId("template-details-canvas").textContent).toBe("1080×1920");
    expect(screen.getByTestId("template-details-duration").textContent).toBe("0:03.5");
    expect(screen.getByTestId("template-details-has-code")).toBeInTheDocument();
    for (const tag of ["promo", "intro"]) expect(screen.getByText(tag)).toBeInTheDocument();
    const video = screen.getByTestId("template-details-video") as HTMLVideoElement;
    expect(video.hasAttribute("controls")).toBe(true);
    expect(video.hasAttribute("muted")).toBe(false);
    expect(video.muted).toBe(false);
    expect(video.getAttribute("src")).toBe("/api/templates/t1/media/example.mp4?v=2-7");
    expect(video.getAttribute("poster")).toBe("/api/templates/t1/media/poster.jpg?v=2-7");
    expect(screen.getByTestId("template-details-use")).toBeInTheDocument();
    expect(screen.getByTestId("template-details-edit")).toBeInTheDocument();
    expect(screen.getByTestId("template-details-delete")).toBeInTheDocument();
    const back = screen.getByTestId("template-details-back");
    expect(back.getAttribute("href")).toBe("/templates");
    expectPointerEverywhere(container);
  });

  it("Use hands the agent the apply prompt for this template", async () => {
    mount(<LocalTemplateDetails id="t1" />);
    fireEvent.click(await screen.findByTestId("template-details-use"));
    expect(openWith).toHaveBeenCalledWith(expect.stringContaining("t1"));
  });

  it("lists the overlays top-most first, with kind, label, key, time and slot", async () => {
    mount(<LocalTemplateDetails id="t1" />);
    const rows = await screen.findAllByTestId("overlay-row");
    expect(rows.map((r) => r.getAttribute("data-key"))).toEqual(["logo", "headline", "hero"]);
    expect(within(rows[0]).getByText("Logo")).toBeInTheDocument();
    expect(within(rows[0]).getByText("logo")).toBeInTheDocument();
    expect(within(rows[0]).getByText("Fixed")).toBeInTheDocument();
    expect(within(rows[0]).getByText("0.5–2.5 s")).toBeInTheDocument();
    expect(within(rows[1]).getByText("Slot: headline")).toBeInTheDocument();
    expect(within(rows[2]).getByText("Slot: hero")).toBeInTheDocument();
  });

  it("lists every resource: the image, audio and font served locally, the link-only video by its host", async () => {
    mount(<LocalTemplateDetails id="t1" />);
    await screen.findAllByTestId("resource-card");
    expect(screen.getByTestId("resource-image-logo").getAttribute("src")).toBe("/api/templates/t1/media/logo.png?as=asset&v=2");
    expect(screen.getByTestId("resource-audio-bed").getAttribute("src")).toBe("/api/templates/t1/media/bed.mp3?as=asset&v=2");
    expect(screen.getByTestId("resource-font-sample-brand").textContent).toBe("The quick brown fox jumps over the lazy dog");
    expect(screen.getByTestId("resource-link-clip").getAttribute("href")).toBe("https://cdn.example.com/clip.mp4");
    expect(screen.getByText("cdn.example.com")).toBeInTheDocument();
  });

  it("shows the use on this machine", async () => {
    mount(<LocalTemplateDetails id="t1" />);
    const local = await screen.findByTestId("usage-local");
    expect(local.textContent).toContain("Used 3 times on this machine");
    expect(local.textContent).toContain("2 in 7 days");
    expect(local.textContent).toContain("3 in 30 days");
    expect(local.textContent).toContain("last used 3d ago");
    expect(screen.queryByTestId("usage-catalog")).toBeNull();
  });

  it("a published template adds the catalog's numbers, its publisher name and its visibility", async () => {
    routes.unshift((url) => (url === "/api/templates/t1" ? { status: 200, body: localDetail({ cloudId: CLOUD }) } : undefined));
    routes.unshift((url) => (url === "/api/templates/cloud/mine" ? { status: 200, body: { nickname: "nadav", templates: [mineEntry()] } } : undefined));
    mount(<LocalTemplateDetails id="t1" />);
    const catalog = await screen.findByTestId("usage-catalog");
    expect(catalog.textContent).toContain("In the catalog");
    expect(catalog.textContent).toContain("6 in 7 days");
    expect(catalog.textContent).toContain("6 in 30 days");
    expect(catalog.textContent).toContain("40 total");
    expect(catalog.textContent).toMatch(/last used \d{1,2} [A-Z][a-z]{2} \d{4} \(UTC\)/);
    expect(screen.getByTestId("template-details-published-as").textContent).toContain("Published as nadav");
    expect(screen.getByTestId(`template-visibility-${CLOUD}`)).toHaveAttribute("data-state", "public");
  });

  it("a moderated template shows its removal reason and How to dispute", async () => {
    routes.unshift((url) => (url === "/api/templates/t1" ? { status: 200, body: localDetail({ cloudId: CLOUD }) } : undefined));
    routes.unshift((url) =>
      url === "/api/templates/cloud/mine"
        ? { status: 200, body: { nickname: "nadav", templates: [mineEntry({ hidden: true, moderated: true, moderation: { reason: "copyright", note: "A claim.", at: "2026-09-24T00:00:00.000Z" } })] } }
        : undefined,
    );
    mount(<LocalTemplateDetails id="t1" />);
    expect((await screen.findByTestId("visibility-removed")).textContent).toContain("Removed — Copyright");
    expect(screen.getByTestId("visibility-dispute")).toHaveAttribute("target", "_blank");
    expect(screen.getByTestId("visibility-removed-note").textContent).toBe("A claim.");
    // The takedown date the counter-notice window counts from (Terms §11).
    expect(screen.getByTestId("visibility-removed-date").textContent).toBe("on 24 Sep 2026 (UTC)");
  });

  it("Delete asks first, deletes, then goes back to the Templates page", async () => {
    let deleted = false;
    routes.unshift((url, init) => (url === "/api/templates/t1" && init?.method === "DELETE" ? ((deleted = true), { status: 200, body: { ok: true } }) : undefined));
    mount(<LocalTemplateDetails id="t1" />);
    fireEvent.click(await screen.findByTestId("template-details-delete"));
    fireEvent.click(await screen.findByTestId("template-delete-confirm"));
    await waitFor(() => expect(deleted).toBe(true));
    await waitFor(() => expect(push).toHaveBeenCalledWith("/templates"));
  });

  it("no example: the poster alone, or the empty box with Render preview", async () => {
    routes.unshift((url) => (url === "/api/templates/t1" ? { status: 200, body: localDetail({ hasExample: false, hasPoster: false, video: null, poster: null }) } : undefined));
    mount(<LocalTemplateDetails id="t1" />);
    expect(await screen.findByTestId("template-details-no-poster")).toBeInTheDocument();
    expect(screen.queryByTestId("template-details-video")).toBeNull();
    expect(screen.getByTestId("template-card-render")).toBeInTheDocument();
  });

  it("a broken template says why and lists no overlays or resources", async () => {
    routes.unshift((url) => (url === "/api/templates/t1" ? { status: 200, body: localDetail({ broken: "template.json missing" }, { scaffold: null }) } : undefined));
    mount(<LocalTemplateDetails id="t1" />);
    expect((await screen.findByTestId("template-details-broken")).textContent).toContain("template.json missing");
    expect(screen.queryByTestId("overlay-row")).toBeNull();
    expect(screen.queryByTestId("resource-card")).toBeNull();
  });

  it("shows the layout's skeleton while loading, and never 'Loading'", async () => {
    routes.unshift((url) => (url === "/api/templates/t1" ? undefined : undefined));
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));
    mount(<LocalTemplateDetails id="t1" />);
    expect(screen.getByTestId("template-details-skeleton")).toBeInTheDocument();
    expect(screen.queryByText(/loading/i)).toBeNull();
  });

  it("404: says the template isn't on this machine any more, with a way back", async () => {
    routes.unshift((url) => (url === "/api/templates/t1" ? { status: 404, body: { error: "template_not_found" } } : undefined));
    mount(<LocalTemplateDetails id="t1" />);
    expect(await screen.findByText("This template isn't on this machine any more.")).toBeInTheDocument();
    expect(screen.getByTestId("template-details-back")).toHaveAttribute("href", "/templates");
  });
});

describe("PublicTemplateDetails", () => {
  const url = `/api/templates/cloud/catalog/${CLOUD}`;

  it("renders the listing by its author, the example with sound, Use and Report", async () => {
    routes.push((u) => (u === url ? { status: 200, body: publicDetail() } : undefined));
    const { container } = mount(<PublicTemplateDetails cloudId={CLOUD} />);
    expect(await screen.findByRole("heading", { level: 1, name: "Hook + caption" })).toBeInTheDocument();
    expect(screen.getByTestId("template-details-author").textContent).toBe("by nadav");
    const video = screen.getByTestId("template-details-video") as HTMLVideoElement;
    expect(video.getAttribute("src")).toBe(`${BASE}templates/${CLOUD}/v3/example.mp4`);
    expect(video.getAttribute("poster")).toBe(`${BASE}templates/${CLOUD}/v3/poster.jpg`);
    expect(video.hasAttribute("controls")).toBe(true);
    expect(video.muted).toBe(false);
    expect(screen.getByTestId("template-details-use")).toBeInTheDocument();
    expect(screen.getByTestId("report-trigger")).toBeInTheDocument();
    expect(screen.getByTestId("template-details-back")).toHaveAttribute("href", "/templates?tab=public");
    expect(screen.queryByTestId("template-details-installed-link")).toBeNull();
    expectPointerEverywhere(container);
  });

  it("links the installed copy when this machine has one", async () => {
    routes.push((u) => (u === url ? { status: 200, body: publicDetail({ installedTemplateId: "local-7", installedOrigin: "installed" }) } : undefined));
    mount(<PublicTemplateDetails cloudId={CLOUD} />);
    const link = await screen.findByTestId("template-details-installed-link");
    expect(link).toHaveAttribute("href", "/templates/local-7");
    expect(link.textContent).toBe("Open your installed copy");
  });

  it("Use installs the version shown, then hands the agent the apply prompt for the installed copy", async () => {
    const posted: unknown[] = [];
    routes.push((u) => (u === url ? { status: 200, body: publicDetail() } : undefined));
    routes.push((u, init) =>
      u === "/api/templates/cloud/install" && init?.method === "POST"
        ? (posted.push(JSON.parse(String(init.body))), { status: 200, body: { ok: true, templateId: "local-9", version: 3, reinstalled: false } })
        : undefined,
    );
    mount(<PublicTemplateDetails cloudId={CLOUD} />);
    fireEvent.click(await screen.findByTestId("template-details-use"));
    await waitFor(() => expect(openWith).toHaveBeenCalledWith(expect.stringContaining("local-9")));
    expect(posted).toEqual([{ cloudId: CLOUD, version: 3 }]);
  });

  it("file assets resolve in the template's bucket folder; one outside it is not rendered", async () => {
    routes.push((u) => (u === url ? { status: 200, body: publicDetail() } : undefined));
    mount(<PublicTemplateDetails cloudId={CLOUD} />);
    expect(await screen.findByTestId("resource-image-logo")).toHaveAttribute("src", `${BASE}templates/${CLOUD}/v3/assets/logo.png`);
    cleanup();
    routes = [(u) => (u === url ? { status: 200, body: publicDetail({ mediaBase: `${BASE}templates/bbbbbbbbbbbbbbbbbbbb/v3/` }) } : undefined)];
    mount(<PublicTemplateDetails cloudId={CLOUD} />);
    await screen.findAllByTestId("resource-card");
    expect(screen.queryByTestId("resource-image-logo")).toBeNull();
    expect(screen.getAllByText("Not available").length).toBeGreaterThan(0);
  });

  it("a public font shows its name and size, no sample", async () => {
    routes.push((u) => (u === url ? { status: 200, body: publicDetail() } : undefined));
    mount(<PublicTemplateDetails cloudId={CLOUD} />);
    const card = (await screen.findAllByTestId("resource-card")).find((c) => c.getAttribute("data-ref") === "brand")!;
    expect(within(card).getByText("Brand.ttf")).toBeInTheDocument();
    expect(within(card).getByText("8.8 KB")).toBeInTheDocument();
    expect(screen.queryByTestId("resource-font-sample-brand")).toBeNull();
  });

  it("without the site's 30-day figures, the catalog line shows 7 days and the total only", async () => {
    routes.push((u) => (u === url ? { status: 200, body: publicDetail() } : undefined));
    mount(<PublicTemplateDetails cloudId={CLOUD} />);
    const line = await screen.findByTestId("usage-catalog");
    expect(line.textContent).toContain("4 in 7 days");
    expect(line.textContent).toContain("12 total");
    expect(line.textContent).not.toContain("30 days");
    expect(line.textContent).not.toContain("last used");
  });

  it("with them, it adds 30 days and the day it was last used", async () => {
    routes.push((u) => (u === url ? { status: 200, body: publicDetail({}, { uses30d: 9, lastUsedDay: "2026-09-20" }) } : undefined));
    mount(<PublicTemplateDetails cloudId={CLOUD} />);
    const line = await screen.findByTestId("usage-catalog");
    expect(line.textContent).toContain("9 in 30 days");
    expect(line.textContent).toContain("last used 20 Sep 2026 (UTC)");
  });

  it("author text renders as plain text, never markup", async () => {
    routes.push((u) => (u === url ? { status: 200, body: publicDetail({}, { name: "<b>Bold</b>", description: "**not markdown**" }) } : undefined));
    const { container } = mount(<PublicTemplateDetails cloudId={CLOUD} />);
    expect(await screen.findByRole("heading", { level: 1, name: "<b>Bold</b>" })).toBeInTheDocument();
    expect(container.querySelector("h1 b")).toBeNull();
    expect(screen.getByText("**not markdown**")).toBeInTheDocument();
  });

  it("loading shows the skeleton; 404 says it is no longer in the catalog", async () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));
    mount(<PublicTemplateDetails cloudId={CLOUD} />);
    expect(screen.getByTestId("template-details-skeleton")).toBeInTheDocument();
    expect(screen.queryByText(/loading/i)).toBeNull();
    cleanup();
    stubFetch();
    routes.push((u) => (u === url ? { status: 404, body: { error: "This template is no longer in the catalog.", code: "not_found" } } : undefined));
    mount(<PublicTemplateDetails cloudId={CLOUD} />);
    expect(await screen.findByText("This template is no longer in the catalog.")).toBeInTheDocument();
    expect(screen.getByTestId("template-details-back")).toHaveAttribute("href", "/templates?tab=public");
  });
});

describe("DetailsSkeleton", () => {
  it("mirrors the page: a player box, header lines, a button row and two table blocks", () => {
    render(<DetailsSkeleton />);
    const root = screen.getByTestId("template-details-skeleton");
    expect(root.querySelectorAll("[data-slot='skeleton']").length).toBeGreaterThanOrEqual(8);
  });
});

describe("D5–D6 review fixes", () => {
  const url = `/api/templates/cloud/catalog/${CLOUD}`;

  it("I1: a public page whose refresh is rate-limited keeps what it showed, says so without a retry, and backs off (no new request)", async () => {
    let answer: { status: number; body: unknown; headers?: Record<string, string> } = { status: 200, body: publicDetail() };
    routes.push((u) => (u === url ? answer : undefined));
    const { client } = mount(<PublicTemplateDetails cloudId={CLOUD} />);
    expect(await screen.findByRole("heading", { level: 1, name: "Hook + caption" })).toBeInTheDocument();
    answer = { status: 429, body: { error: "The catalog asked libi to slow down. Try again in a minute.", code: "rate_limited", retryAfterSec: 30 }, headers: { "retry-after": "30" } };
    await client.invalidateQueries();
    expect(await screen.findByTestId("template-details-refresh-failed")).toHaveTextContent("The catalog asked libi to slow down");
    expect(screen.queryByTestId("template-details-refresh-retry")).toBeNull();
    // The page — and its Use button — stayed.
    expect(screen.getByRole("heading", { level: 1, name: "Hook + caption" })).toBeInTheDocument();
    expect(screen.getByTestId("template-details-use")).toBeInTheDocument();
    const asked = fetched.filter((u) => u === url).length;
    await client.invalidateQueries();
    await new Promise((r) => setTimeout(r, 20));
    expect(fetched.filter((u) => u === url).length).toBe(asked);
  });

  it("I1: a local page whose refresh fails keeps the template, with a notice and Retry", async () => {
    let status = 200;
    routes.push((u) => (u === "/api/templates/t1" ? (status === 200 ? { status, body: localDetail() } : { status, body: { error: "boom" } }) : undefined));
    const { client } = mount(<LocalTemplateDetails id="t1" />);
    expect(await screen.findByRole("heading", { level: 1, name: "Lower third" })).toBeInTheDocument();
    status = 500;
    await client.invalidateQueries();
    expect(await screen.findByTestId("template-details-refresh-failed")).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1, name: "Lower third" })).toBeInTheDocument();
    status = 200;
    fireEvent.click(screen.getByTestId("template-details-refresh-retry"));
    await waitFor(() => expect(screen.queryByTestId("template-details-refresh-failed")).toBeNull());
  });

  it("I2: a first answer of 429 shows the catalog's words and no Try again", async () => {
    routes.push((u) => (u === url ? { status: 429, body: { error: "The catalog asked libi to slow down. Try again in a minute.", code: "rate_limited" }, headers: { "retry-after": "30" } } : undefined));
    mount(<PublicTemplateDetails cloudId={CLOUD} />);
    expect(await screen.findByText("The catalog asked libi to slow down. Try again in a minute.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
  });

  it("I3 / streaming: a dropped asset is counted, never shown; the link-only video plays through libi's stream after Play", async () => {
    routes.push((u) => (u === url ? { status: 200, body: publicDetail({ droppedAssets: 2 }) } : undefined));
    mount(<PublicTemplateDetails cloudId={CLOUD} />);
    expect(await screen.findByTestId("template-details-dropped-assets")).toHaveTextContent("2 resources aren't shown");
    const play = screen.getByTestId("resource-play-clip");
    expect(fetched.some((u) => u.includes("asset-stream"))).toBe(false);
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
    fireEvent.click(play);
    const video = await screen.findByTestId("resource-video-clip");
    expect(video.getAttribute("src")).toBe(`/api/templates/cloud/asset-stream?cloudId=${CLOUD}&url=${encodeURIComponent("https://cdn.example.com/clip.mp4")}`);
    expect(screen.getByTestId("resource-link-clip")).toHaveAttribute("href", "https://cdn.example.com/clip.mp4");
  });

  it("M1: a local template nobody published never reads /mine (it spends the creator key); a published one does", async () => {
    routes.push((u) => (u === "/api/templates/t1" ? { status: 200, body: localDetail() } : undefined));
    mount(<LocalTemplateDetails id="t1" />);
    expect(await screen.findByRole("heading", { level: 1, name: "Lower third" })).toBeInTheDocument();
    await new Promise((r) => setTimeout(r, 20));
    expect(fetched).not.toContain("/api/templates/cloud/mine");
    cleanup();
    routes = [(u) => (u === "/api/templates/t1" ? { status: 200, body: localDetail({ cloudId: CLOUD }) } : undefined)];
    mount(<LocalTemplateDetails id="t1" />);
    await waitFor(() => expect(fetched).toContain("/api/templates/cloud/mine"));
  });

  it("M2: the author's own published template is 'Open your template', not an installed copy", async () => {
    routes.push((u) => (u === url ? { status: 200, body: publicDetail({ installedTemplateId: "mine-1", installedOrigin: "local" }) } : undefined));
    mount(<PublicTemplateDetails cloudId={CLOUD} />);
    expect((await screen.findByTestId("template-details-installed-link")).textContent).toBe("Open your template");
  });

  it("M3: the skeleton's player takes the template's shape from a list already loaded, else 16:9", async () => {
    render(<DetailsSkeleton />);
    expect(screen.getByTestId("template-details-skeleton-player").style.aspectRatio).toBe("16 / 9");
    cleanup();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
    client.setQueryData(["templates", "list", { order: "trending" }], [summary({ canvas: { width: 1080, height: 1920, fps: 30 } })]);
    routes.push((u) => (u === "/api/templates/t1" ? undefined : undefined));
    mount(<LocalTemplateDetails id="t1" />, client);
    expect(screen.getByTestId("template-details-skeleton-player").style.aspectRatio).toBe("1080 / 1920");
  });

  it("M4: the example player is named", async () => {
    routes.push((u) => (u === "/api/templates/t1" ? { status: 200, body: localDetail() } : undefined));
    mount(<LocalTemplateDetails id="t1" />);
    expect(await screen.findByTestId("template-details-video")).toHaveAccessibleName("Template example");
  });

  it("M8: Delete goes back to the Templates page without ever flashing 'not on this machine'", async () => {
    let deleted = false;
    routes.push((u, init) => {
      if (u !== "/api/templates/t1") return undefined;
      if (init?.method === "DELETE") return (deleted = true), { status: 200, body: { ok: true } };
      return deleted ? { status: 404, body: { error: "template_not_found" } } : { status: 200, body: localDetail() };
    });
    mount(<LocalTemplateDetails id="t1" />);
    fireEvent.click(await screen.findByTestId("template-details-delete"));
    fireEvent.click(await screen.findByTestId("template-delete-confirm"));
    await waitFor(() => expect(push).toHaveBeenCalledWith("/templates"));
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.queryByText("This template isn't on this machine any more.")).toBeNull();
    // The page's one read and the DELETE: its own query is never re-read (that re-read answered 404).
    expect(fetched.filter((u) => u === "/api/templates/t1")).toHaveLength(2);
  });

  it("M5: the overlays table keeps all four columns — no minimum width that pushes Time and Slot off a phone screen", async () => {
    routes.push((u) => (u === "/api/templates/t1" ? { status: 200, body: localDetail() } : undefined));
    mount(<LocalTemplateDetails id="t1" />);
    const table = await screen.findByTestId("overlays-table");
    expect(table.className).not.toMatch(/min-w-/);
    expect(within(table).getAllByRole("columnheader").map((h) => h.textContent)).toEqual(["Kind", "Name", "Time", "Slot"]);
  });

  it("fix-round N4: a loaded public page whose refetch says the template left the catalog shows so, and its players are gone", async () => {
    let answer: { status: number; body: unknown } = { status: 200, body: publicDetail() };
    routes.push((u) => (u === url ? answer : undefined));
    const { client } = mount(<PublicTemplateDetails cloudId={CLOUD} />);
    expect(await screen.findByTestId("resource-play-clip")).toBeInTheDocument();
    answer = { status: 404, body: { error: "This template is no longer in the catalog.", code: "not_found" } };
    await client.invalidateQueries();
    expect(await screen.findByTestId("template-details-message")).toHaveTextContent("This template is no longer in the catalog.");
    expect(screen.queryByTestId("resource-play-clip")).toBeNull();
    expect(document.querySelectorAll("video, audio")).toHaveLength(0);
    expect(screen.queryByTestId("template-details-use")).toBeNull();
  });

  it("fix-round N4: a local page whose template was deleted elsewhere says so", async () => {
    let status = 200;
    routes.push((u) => (u === "/api/templates/t1" ? (status === 200 ? { status, body: localDetail() } : { status, body: { error: "template_not_found" } }) : undefined));
    const { client } = mount(<LocalTemplateDetails id="t1" />);
    expect(await screen.findByRole("heading", { level: 1, name: "Lower third" })).toBeInTheDocument();
    status = 404;
    await client.invalidateQueries({ queryKey: ["templates", "detail", "t1"] });
    expect(await screen.findByTestId("template-details-message")).toHaveTextContent("This template isn't on this machine any more.");
  });

  it("fix-round N5: after one template's 429, another template's page doesn't ask either until Retry-After", async () => {
    const other = "zzzzzzzzzzzzzzzzzzzz";
    routes.push((u) => (u === url ? { status: 429, body: { error: "The catalog asked libi to slow down. Try again in a minute.", code: "rate_limited" }, headers: { "retry-after": "30" } } : undefined));
    routes.push((u) => (u === `/api/templates/cloud/catalog/${other}` ? { status: 200, body: publicDetail() } : undefined));
    mount(<PublicTemplateDetails cloudId={CLOUD} />);
    expect(await screen.findByText("The catalog asked libi to slow down. Try again in a minute.")).toBeInTheDocument();
    cleanup();
    mount(<PublicTemplateDetails cloudId={other} />);
    expect(await screen.findByText("The catalog asked libi to slow down. Try again in a minute.")).toBeInTheDocument();
    expect(fetched).not.toContain(`/api/templates/cloud/catalog/${other}`);
  });

  // Confirmation review C1: a page left open past the stream route's 15-minute listing window.
  describe("Play more than 15 minutes after the page loaded", () => {
    const realNow = Date.now.bind(Date);
    /** From now on, the clock reads `ms` later than it is. */
    const later = (ms: number) => vi.spyOn(Date, "now").mockImplementation(() => realNow() + ms);
    afterEach(() => vi.restoreAllMocks());

    it("still listed: Play re-reads the page once, then plays through the stream", async () => {
      routes.push((u) => (u === url ? { status: 200, body: publicDetail() } : undefined));
      vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
      mount(<PublicTemplateDetails cloudId={CLOUD} />);
      const play = await screen.findByTestId("resource-play-clip");
      const reads = fetched.filter((u) => u === url).length;
      later(16 * 60_000);
      fireEvent.click(play);
      const video = await screen.findByTestId("resource-video-clip");
      expect(video.getAttribute("src")).toContain("/api/templates/cloud/asset-stream?");
      expect(fetched.filter((u) => u === url).length).toBe(reads + 1);
      expect(screen.queryByTestId("resource-stream-failed-clip")).toBeNull();
    });

    it("delisted meanwhile: Play shows 'no longer in the catalog', and nothing plays", async () => {
      let listed = true;
      routes.push((u) => (u === url ? (listed ? { status: 200, body: publicDetail() } : { status: 404, body: { error: "This template is no longer in the catalog.", code: "not_found" } }) : undefined));
      mount(<PublicTemplateDetails cloudId={CLOUD} />);
      const play = await screen.findByTestId("resource-play-clip");
      listed = false;
      later(16 * 60_000);
      fireEvent.click(play);
      expect(await screen.findByTestId("template-details-message")).toHaveTextContent("This template is no longer in the catalog.");
      expect(document.querySelectorAll("video, audio")).toHaveLength(0);
      expect(fetched.some((u) => u.includes("asset-stream"))).toBe(false);
    });

    it("within 10 minutes of loading, Play doesn't re-read at all", async () => {
      routes.push((u) => (u === url ? { status: 200, body: publicDetail() } : undefined));
      vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
      mount(<PublicTemplateDetails cloudId={CLOUD} />);
      const play = await screen.findByTestId("resource-play-clip");
      const reads = fetched.filter((u) => u === url).length;
      fireEvent.click(play);
      await screen.findByTestId("resource-video-clip");
      expect(fetched.filter((u) => u === url).length).toBe(reads);
    });

    it("a stream that fails re-reads the page, so a template that left the catalog says so", async () => {
      let listed = true;
      routes.push((u) => (u === url ? (listed ? { status: 200, body: publicDetail() } : { status: 404, body: { error: "gone", code: "not_found" } }) : undefined));
      vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
      mount(<PublicTemplateDetails cloudId={CLOUD} />);
      fireEvent.click(await screen.findByTestId("resource-play-clip"));
      const video = await screen.findByTestId("resource-video-clip");
      listed = false;
      fireEvent.error(video);
      expect(await screen.findByTestId("template-details-message")).toHaveTextContent("This template is no longer in the catalog.");
    });
  
    it("Play during the catalog's 429 backoff says the catalog asked libi to slow down, not 'couldn't play' (final review F11)", async () => {
      let limited = false;
      routes.push((u) =>
        u === url
          ? limited
            ? { status: 429, body: { error: "The catalog asked libi to slow down. Try again in a minute.", code: "rate_limited" }, headers: { "retry-after": "30" } }
            : { status: 200, body: publicDetail() }
          : undefined,
      );
      mount(<PublicTemplateDetails cloudId={CLOUD} />);
      const play = await screen.findByTestId("resource-play-clip");
      limited = true;
      later(16 * 60_000);
      fireEvent.click(play);
      expect(await screen.findByTestId("resource-stream-failed-clip")).toHaveTextContent("The catalog asked libi to slow down. Try again in a minute.");
      expect(screen.queryByTestId("resource-video-clip")).toBeNull();
    });

    it("an absurd Retry-After holds the page back 10 minutes at most — the server's cap (final review F5)", async () => {
      routes.push((u) => (u === url ? { status: 429, body: { error: "The catalog asked libi to slow down. Try again in a minute.", code: "rate_limited" }, headers: { "retry-after": "999999" } } : undefined));
      mount(<PublicTemplateDetails cloudId={CLOUD} />);
      await screen.findByText("The catalog asked libi to slow down. Try again in a minute.");
      cleanup();
      const asked = fetched.filter((u) => u === url).length;
      later(601_000);
      mount(<PublicTemplateDetails cloudId={CLOUD} />);
      await waitFor(() => expect(fetched.filter((u) => u === url).length).toBe(asked + 1));
    });
  });

  it("a malformed id (400) says it isn't a catalog template's address — not 'no longer in the catalog' (final review F11)", async () => {
    routes.push((u) => (u.startsWith("/api/templates/cloud/catalog/") ? { status: 400, body: { error: "Not a catalog template id.", code: "invalid" } } : undefined));
    mount(<PublicTemplateDetails cloudId="bad" />);
    expect(await screen.findByTestId("template-details-message")).toHaveTextContent("This isn't the address of a catalog template.");
  });
});
