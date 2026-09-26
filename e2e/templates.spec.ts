import path from "path";
import type { APIRequestContext, Page } from "@playwright/test";
import { test, expect } from "./helpers/app";

/**
 * Templates page (spec §10), in a browser: the seeded template renders as a
 * card and a table row, search / tag chips / the order select narrow and
 * reorder it, hover plays the example clip muted and leave stops it, `Use`
 * hands the agent a prompt (and makes nothing), sending it takes the user to the
 * editor where the applied piece opens, and `Delete` removes it.
 *
 * Tests run in declaration order (`workers: 1`, `fullyParallel: false`) against
 * ONE spawned libi and one scratch home, so each test builds on what the last
 * left behind: 1 seeds the `lower-third` fixture, 2 adds a second template and
 * records a use on the first, 3–5 read them (5 also applies the first once more),
 * 6 applies it again and checks its code layer runs in the overlay sandbox,
 * 7 deletes both — leaving the home
 * as empty of templates as it started.
 *
 * `libi.*` calls go through `/api/e2e/run-tool`, whose template entries fire the
 * same `refresh_query`s `mcp/server.ts` does, so the page updates over the one
 * SSE without a reload — exactly the path an agent's call takes.
 */
const FIXTURE = path.resolve(__dirname, "..", "__tests__", "helpers", "fixtures", "templates", "lower-third");

interface TemplateRow {
  id: string;
  name: string;
  createdAt: string;
}

/** Every local template, as the page reads them. */
async function listTemplates(request: APIRequestContext): Promise<TemplateRow[]> {
  const res = await request.get("/api/templates");
  expect(res.ok()).toBe(true);
  return ((await res.json()) as { templates: TemplateRow[] }).templates;
}

/**
 * The row named `name`, looked up per test rather than carried in a module
 * variable: Playwright shuts the worker down after a failing test, so state a
 * `let` held would be undefined for every test after the first failure — and
 * the resulting `(id undefined)` failures hide the one that actually broke.
 */
async function templateByName(request: APIRequestContext, name: string): Promise<TemplateRow> {
  const row = (await listTemplates(request)).find((t) => t.name === name);
  expect(row, `no template named "${name}" — did an earlier test in this file fail?`).toBeTruthy();
  return row!;
}

async function runTool(
  request: APIRequestContext,
  tool: string,
  args: Record<string, unknown>,
): Promise<{ success: boolean; data?: Record<string, unknown>; error?: string }> {
  const res = await request.post("/api/e2e/run-tool", { data: { tool, args } });
  const body = (await res.json()) as { success: boolean; data?: Record<string, unknown>; error?: string };
  expect(res.ok(), `${tool} → HTTP ${res.status()} ${JSON.stringify(body)}`).toBe(true);
  expect(body.success, `${tool} → ${JSON.stringify(body)}`).toBe(true);
  return body;
}

async function seed(request: APIRequestContext): Promise<string> {
  const res = await request.post("/api/e2e/seed-template", { data: { dir: FIXTURE } });
  expect(res.ok(), `seed-template → HTTP ${res.status()} ${await res.text()}`).toBe(true);
  return ((await res.json()) as { templateId: string }).templateId;
}

async function pieceCount(request: APIRequestContext): Promise<number> {
  const res = await request.get("/api/pieces");
  expect(res.ok()).toBe(true);
  return ((await res.json()) as unknown[]).length;
}

async function newPieceId(request: APIRequestContext): Promise<string> {
  const res = await request.post("/api/pieces");
  expect(res.ok()).toBe(true);
  return ((await res.json()) as { id: string }).id;
}

/** The h1. `exact` matters: the table below it is headed "Your templates". */
function pageHeading(page: Page) {
  return page.getByRole("heading", { name: "Templates", exact: true });
}

async function openTemplates(page: Page): Promise<void> {
  await page.goto("/templates");
  await expect(pageHeading(page)).toBeVisible({ timeout: 30_000 });
}

/** The order select is a portalled listbox: open the trigger, pick the item. */
async function chooseOrder(page: Page, order: "trending" | "most-used" | "newest"): Promise<void> {
  await page.getByTestId("templates-order").click();
  await page.getByTestId(`templates-order-${order}`).click();
}

test.describe("Templates page", () => {
  test("empty state, then the seeded template as a card and a table row", async ({ page, request }) => {
    await openTemplates(page);
    // A fresh scratch home has no templates, and the empty state — not a
    // toolbar over nothing — is what the user sees.
    await expect(page.getByTestId("templates-empty")).toBeVisible();
    await expect(page.getByTestId("templates-empty-create")).toBeVisible();
    await expect(page.getByTestId("templates-grid")).toHaveCount(0);

    const templateId = await seed(request);

    // No reload: the seed route emits `refresh_query { templates }` and the
    // page's React Query cache is invalidated over the app-wide SSE.
    const card = page.getByTestId("template-card");
    await expect(card).toHaveCount(1, { timeout: 15_000 });
    await expect(card).toHaveAttribute("data-template-id", templateId);
    await expect(card.getByTestId("template-card-name")).toHaveText("Lower third");
    // The fixture carries a code overlay and two slots (headline, clip).
    await expect(card.getByTestId("template-card-has-code")).toBeVisible();
    await expect(card.getByTestId("template-card-uses")).toContainText("2 slots");
    await expect(card.getByTestId("template-card-uses")).toContainText("0 total");
    // It ships no poster.jpg, so the media box falls back to the canvas size.
    await expect(card.getByTestId("template-card-no-poster")).toHaveText("1080×1920");
    // Cards is the default view; the table ("Your templates") is the List view.
    await expect(page.getByTestId("templates-table")).toHaveCount(0);
    await page.getByTestId("templates-view-list").click();
    await expect(page).toHaveURL(/view=list/);

    const row = page.getByTestId("templates-table-row");
    await expect(row).toHaveCount(1);
    await expect(row).toHaveAttribute("data-template-id", templateId);
    await expect(row).toContainText("Lower third");
  });

  test("search, tag chip and the order select narrow and reorder the grid", async ({ page, request }) => {
    const seeded = await templateByName(request, "Lower third");
    // `templates.created_at` is written by sqlite's `unixepoch()` — whole
    // SECONDS — and `newest` breaks a tie by leaving the rows in table order.
    // Two templates minted in the same second would therefore order the same
    // under every setting, and the select's effect would be unobservable. This
    // waits out the rest of the seeded template's second — a bound read off
    // its own stored timestamp, not a fixed sleep.
    const nextSecond = Math.floor(Date.parse(seeded.createdAt) / 1000) * 1000 + 1000;
    await expect.poll(() => Date.now() >= nextSecond, { timeout: 5_000, intervals: [50] }).toBe(true);

    // A second template, created the way an agent creates one. An empty piece
    // is enough: this test is about the page's filtering, not the capture.
    await runTool(request, "libi.create_template_from_piece", {
      pieceId: await newPieceId(request),
      name: "Product reveal",
      description: "A slow push-in on the product",
      tags: ["ugc"],
    });
    const second = await templateByName(request, "Product reveal");
    // The premise of the `newest` assertion below, stated where it fails loudly.
    expect(Date.parse(second.createdAt)).toBeGreaterThan(Date.parse(seeded.createdAt));

    await openTemplates(page);
    const cards = page.getByTestId("template-card");
    await expect(cards).toHaveCount(2);

    // Search narrows, and clearing it restores both (the box debounces 200 ms,
    // which `toHaveCount` waits out).
    await page.getByTestId("list-search").fill("reveal");
    await expect(cards).toHaveCount(1);
    await expect(cards.getByTestId("template-card-name")).toHaveText("Product reveal");
    await page.getByTestId("list-search").fill("");
    await expect(cards).toHaveCount(2);

    // A tag chip narrows the same grid, and toggling it off restores it.
    const ugc = page.getByTestId("template-tag-chip").filter({ hasText: "ugc" });
    await ugc.click();
    await expect(cards).toHaveCount(1);
    await expect(cards.getByTestId("template-card-name")).toHaveText("Product reveal");
    await expect(ugc).toHaveAttribute("aria-pressed", "true");
    await ugc.click();
    await expect(cards).toHaveCount(2);

    // Order needs the two to differ on something: "Product reveal" is the
    // newer, and one apply makes "Lower third" the more used. The apply is also
    // what proves the run-tool entry's `templates` refresh — the counts on
    // screen move without a reload.
    await runTool(request, "libi.apply_template", {
      templateId: seeded.id,
      newPiece: {},
      slotValues: { headline: "Ada Lovelace" },
    });
    await expect(
      page.getByTestId("template-card").filter({ hasText: "Lower third" }).getByTestId("template-card-uses"),
    ).toContainText("1 total", { timeout: 15_000 });

    await chooseOrder(page, "newest");
    await expect(cards.first().getByTestId("template-card-name")).toHaveText("Product reveal");
    await chooseOrder(page, "most-used");
    await expect(cards.first().getByTestId("template-card-name")).toHaveText("Lower third");
  });

  test("hover plays the example clip muted, leaving stops and rewinds it", async ({ page }) => {
    await openTemplates(page);
    const card = page.getByTestId("template-card").filter({ hasText: "Lower third" });
    const video = card.getByTestId("template-card-video");
    // `src` is set on first hover, not on load: a grid of templates must not
    // open a stream per card.
    await expect(video).toBeHidden();
    expect(await video.getAttribute("src")).toBeNull();

    await card.hover();
    // `?v=<version>-<mediaRev>`: the media is cached, so the URL changes when
    // the example is re-rendered without a version bump (template-card.tsx).
    await expect(video).toHaveAttribute("src", /\/media\/example\.mp4\?v=\d+-\d+$/);
    await expect(video).toBeVisible();
    // Headless Chromium can't be judged by pixels, so the element's own state
    // is the evidence: playing, and muted while it does.
    await expect
      .poll(async () => video.evaluate((v) => !(v as HTMLVideoElement).paused && (v as HTMLVideoElement).muted), {
        timeout: 15_000,
      })
      .toBe(true);

    // Leaving the card stops it, hides it again (so the poster/size fallback
    // comes back rather than a frozen frame) and rewinds it to the start.
    await pageHeading(page).hover();
    await expect
      .poll(async () => video.evaluate((v) => (v as HTMLVideoElement).paused && (v as HTMLVideoElement).currentTime === 0), {
        timeout: 15_000,
      })
      .toBe(true);
    await expect(video).toBeHidden();
  });

  test("Use hands the agent a prompt and creates nothing", async ({ page, request }) => {
    const { id: templateId } = await templateByName(request, "Lower third");
    const before = await pieceCount(request);
    await openTemplates(page);
    const card = page.getByTestId("template-card").filter({ hasText: "Lower third" });
    await card.getByTestId("template-use").click();

    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    // The prompt carries the template's id (its authority) and the call the
    // agent is being asked to make.
    await expect(dialog).toContainText(`(id ${templateId})`);
    await expect(dialog).toContainText("libi.apply_template");
    await expect(dialog).toContainText('"Lower third"');

    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    // `Use` is a hand-off, never a write: `apply_template({ newPiece: {} })`
    // makes the piece, so closing the dialog leaves nothing behind.
    expect(await pieceCount(request)).toBe(before);
  });

  /**
   * Task 13's walk-through: Send from Use applied the template, but the user
   * stayed on /templates with no chat, and the navigate event that should have
   * opened the new piece reached no listener. Now Send takes the user to the
   * editor, and an "open this piece" that beats the editor's mount is parked
   * for it (lib/agents/agent-handoff.ts).
   *
   * There is no agent in e2e, so the dispatch is stubbed and the agent's one
   * call is made through run-tool — the same tool function, and the same
   * `navigate` over the one SSE, that a real agent's call produces. The race is
   * forced, not hoped for: the editor's route payload is held until the apply
   * has emitted its navigate, so the event arrives while no editor is mounted.
   */
  test("Send takes the user to the editor, and the applied piece opens there", async ({ page, request }) => {
    const { id: templateId } = await templateByName(request, "Lower third");
    await page.route("**/api/agent/dispatch", (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ success: true, sessionId: "e2e-handoff-session" }) }),
    );
    let releaseEditor!: () => void;
    const editorReleased = new Promise<void>((resolve) => (releaseEditor = resolve));
    let editorHeld = false;
    await page.route(/\/editor(\?|$)/, async (route) => {
      editorHeld = true;
      await editorReleased;
      await route.continue();
    });

    await openTemplates(page);
    await page.getByTestId("template-card").filter({ hasText: "Lower third" }).getByTestId("template-use").click();
    await page.getByRole("dialog").getByRole("button", { name: "Send to libi agent" }).click();
    await expect.poll(() => editorHeld, { timeout: 15_000 }).toBe(true);

    const opened = page.waitForRequest(
      (req) => req.url().endsWith("/api/editor/open-piece") && (req.postDataJSON() as { pieceId: string | null }).pieceId !== null,
      { timeout: 60_000 },
    );
    const applied = await runTool(request, "libi.apply_template", {
      templateId,
      newPiece: {},
      slotValues: { headline: "Grace Hopper" },
    });
    const pieceId = (applied.data as { pieceId: string }).pieceId;
    expect((applied.data as { navigated: boolean }).navigated).toBe(true);

    releaseEditor();
    await expect(page).toHaveURL(/\/editor$/, { timeout: 30_000 });
    await expect(page.getByTestId("editor-panel")).toBeVisible({ timeout: 30_000 });
    // The editor opened the APPLIED piece — not the one it would have restored.
    expect(((await opened).postDataJSON() as { pieceId: string }).pieceId).toBe(pieceId);
    await page.unroute(/\/editor(\?|$)/);
  });

  /**
   * Templates × overlay sandbox: an applied template's code layer is written
   * into the piece like any other body (`saveManifest` → its code file) and
   * runs in the sandboxed runtime — the opaque-origin iframe and its `blob:null`
   * worker — never in the app origin. The sandbox boots only once a piece has a
   * body, so the frame appearing is the template's body reaching it.
   */
  test("an applied template's code layer runs in the overlay sandbox, with no render diagnostics", async ({ page, request }) => {
    const { id: templateId } = await templateByName(request, "Lower third");
    const applied = await runTool(request, "libi.apply_template", {
      templateId,
      newPiece: {},
      slotValues: { headline: "Ada Lovelace" },
    });
    const pieceId = (applied.data as { pieceId: string }).pieceId;
    // The fixture's code layer starts at 0.5 s; the editor opens paused at 0.
    // Move it onto the frame the preview draws, so its body actually renders.
    const overlays = await runTool(request, "libi.get_overlays", { pieceId });
    const list = ((overlays.data as { overlays?: unknown[] })?.overlays ?? overlays.data) as Array<{ id: string; kind: string }>;
    const sparkle = list.find((o) => o.kind === "code");
    expect(sparkle, JSON.stringify(list)).toBeTruthy();
    await runTool(request, "libi.update_overlay", { pieceId, overlayId: sparkle!.id, startTime: 0 });

    await page.goto(`/editor?piece=${pieceId}`);
    await expect(page.getByTestId("editor-panel")).toBeVisible({ timeout: 30_000 });
    await page.getByRole("tab", { name: "Timeline" }).click();

    const frame = page.locator('iframe[src^="/sandbox/overlay-runtime"]');
    await expect(frame).toHaveCount(1, { timeout: 20_000 });
    expect(await frame.getAttribute("sandbox")).toBe("allow-scripts");
    await expect.poll(() => page.workers().some((w) => w.url().startsWith("blob:null/")), { timeout: 20_000 }).toBe(true);

    // Give the preview a moment to render and report, then read what the agent
    // reads. (Checked the other way round: the same fixture with a body that
    // throws reports a `render` diagnostic here.)
    await page.waitForTimeout(2_000);
    const state = await runTool(request, "libi.get_piece_state", { pieceId });
    expect(state.data?.renderDiagnostics).toEqual([]);
  });

  test("Delete asks first, then removes the card and the row", async ({ page, request }) => {
    const { id: templateId } = await templateByName(request, "Lower third");
    await openTemplates(page);
    await expect(page.getByTestId("template-card")).toHaveCount(2);
    const card = page.getByTestId("template-card").filter({ hasText: "Product reveal" });
    await card.getByTestId("template-delete").click();
    // The card is still there while the confirm is open — nothing is deleted
    // by opening the dialog.
    await expect(page.getByTestId("template-card")).toHaveCount(2);
    await page.getByTestId("template-delete-confirm").click();

    await expect(page.getByTestId("template-card")).toHaveCount(1);
    await expect(page.getByTestId("template-card").getByTestId("template-card-name")).toHaveText("Lower third");
    await page.getByTestId("templates-view-list").click();
    await expect(page.getByTestId("templates-table-row")).toHaveCount(1);
    await page.getByTestId("templates-view-cards").click();

    // Leave the home as this file found it, through the agent's own tool — and
    // with it, cover the last two run-tool entries: the page falls back to the
    // empty state over the SSE, and the list agrees.
    await runTool(request, "libi.delete_template", { templateId });
    await expect(page.getByTestId("templates-empty")).toBeVisible({ timeout: 15_000 });
    const list = await runTool(request, "libi.list_templates", {});
    expect((list.data as { templates: unknown[] }).templates).toHaveLength(0);
  });
});
