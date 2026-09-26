import { createHash, randomBytes } from "crypto";
import fs from "fs";
import path from "path";
import type { APIRequestContext, Locator, Page, Request } from "@playwright/test";
import { SCAFFOLD_SCHEMA_SHA256 } from "@/lib/templates/scaffold-schema";
import { asThePage, test, expect } from "./helpers/app";

/**
 * The Templates page's Public tab against test mode's fixture catalog
 * (lib/templates/cloud/test-fixture.ts, served at /api/test-mode/templates-catalog/*):
 * three seeded templates, browsed, searched and ordered; hover-play; Use →
 * install → the agent hand-off; Report; "Publishing as"; "Your templates" with a
 * row that exists only in the catalog; and the offline and empty states.
 *
 * The tests are SERIAL against ONE spawned libi, so the fixture's in-memory
 * catalog and the scratch home carry over, and a failure skips the rest rather
 * than cascading: 1 makes libi forget any catalog copy an earlier spec left
 * (DELETE /api/test-mode/catalog-cache) and opens the tab while the catalog is
 * failing; 3 adds uses to "Vertical kinetic caption"; 5 installs "Red
 * caption"; 7 sets the nickname; 8 deletes the install and publishes one
 * template under this install's creator key; 9 empties the catalog. `afterAll`
 * swaps in a fresh creator key and deletes local templates, so a spec that runs
 * after this one in the same libi (e2e/templates.spec.ts expects an empty
 * library) finds none. The fixture's call trace is read from where it stood
 * when each test began, so its exact counts hold on a reused LIBI_E2E_HOME.
 *
 * Nothing here may reach the real catalog: every page request for
 * storage.googleapis.com or nagellabs.com is intercepted, aborted and failed
 * on. The server's own calls are shown to go to the fixture by the media base
 * it hands the page and by the fixture's call trace. That covers only the
 * server paths this spec drives — Playwright can't intercept the server's own
 * fetches, so a path it never drives (the use reporter, the app's publish job)
 * or a call made to BOTH the fixture and the real site would go unnoticed here.
 */

const FIXTURE = "/api/test-mode/templates-catalog";
const GREEN = "aaaaaaaaaaaaaaaaaaa2";
const RED = "bbbbbbbbbbbbbbbbbbb3";
const VERTICAL = "ccccccccccccccccccc4";
const SEED_NAMES = ["Green hook", "Red caption", "Vertical kinetic caption"];
const PUBLISHED_NAME = "E2E published hook";
const NICKNAME = "e2e-bot";

/** The real catalog: its bucket, and the site that fronts it. */
const REAL_CATALOG = /^https?:\/\/([^/]*\.)?(storage\.googleapis\.com|nagellabs\.com)(:\d+)?(\/|$)/i;

let leaked: string[] = [];
/** The trace file's length when the running test began: its reads start there. */
let traceStart = 0;

test.beforeEach(async ({ page }) => {
  leaked = [];
  traceStart = fs.existsSync(traceFile()) ? fs.statSync(traceFile()).size : 0;
  await page.context().route(REAL_CATALOG, (route) => {
    leaked.push(route.request().url());
    return route.abort();
  });
});

test.afterEach(() => {
  expect(leaked, "the page asked the real catalog for something").toEqual([]);
});

test.afterAll(async ({ playwright }) => {
  const request = await playwright.request.newContext({ baseURL: `http://127.0.0.1:${process.env.LIBI_E2E_PORT}` });
  try {
    for (const t of await localTemplates(request)) await request.delete(`/api/templates/${t.id}`);
    // A fresh key has published nothing, so "Your templates" lists no catalog-only row.
    await request.put("/api/templates/cloud/key", { data: { key: randomBytes(32).toString("base64url"), replace: true }, headers: asThePage() });
  } finally {
    await request.dispose();
  }
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface LocalTemplate {
  id: string;
  name: string;
  origin: "local" | "installed";
  cloudId: string | null;
}

async function localTemplates(request: APIRequestContext): Promise<LocalTemplate[]> {
  const res = await request.get("/api/templates?scope=local");
  expect(res.ok()).toBe(true);
  return ((await res.json()) as { templates: LocalTemplate[] }).templates;
}

async function pieceCount(request: APIRequestContext): Promise<number> {
  const res = await request.get("/api/pieces");
  expect(res.ok()).toBe(true);
  return ((await res.json()) as unknown[]).length;
}

/** The next request to the fixture's `route` answers `code` (the site's status for it). */
async function injectFault(request: APIRequestContext, route: string, code: string): Promise<void> {
  const res = await request.post(`${FIXTURE}/_faults`, { data: { route, code } });
  expect(res.ok(), await res.text()).toBe(true);
}

function traceFile(): string {
  return path.join(process.env.LIBI_E2E_HOME!, "test-mode", "templates-catalog-calls.jsonl");
}

/**
 * Every call the fixture served during the running test, as it traces them for
 * the skill-eval harness. The file outlives a run on a reused LIBI_E2E_HOME, so
 * only what was appended since the test began counts.
 */
function fixtureTrace(): Array<{ tool: string; input: Record<string, unknown>; status: number }> {
  const file = traceFile();
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file)
    .subarray(traceStart)
    .toString("utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

async function openPublic(page: Page): Promise<void> {
  await page.goto("/templates?tab=public");
  await expect(page.getByTestId("public-tab")).toBeVisible({ timeout: 30_000 });
}

async function openMine(page: Page): Promise<void> {
  await page.goto("/templates?tab=mine");
  await expect(page.getByRole("heading", { name: "Templates", exact: true })).toBeVisible({ timeout: 30_000 });
}

function card(page: Page, name: string): Locator {
  return page.getByTestId("public-card").filter({ has: page.getByTestId("public-card-name").getByText(name, { exact: true }) });
}

async function cardNames(page: Page): Promise<string[]> {
  return page.getByTestId("public-card-name").allTextContents();
}

/** The order select is a portalled listbox: open the trigger, pick the item. */
async function chooseOrder(page: Page, order: "trending" | "most-used" | "newest"): Promise<void> {
  await page.getByTestId("templates-order").click();
  await page.getByTestId(`templates-order-${order}`).click();
}

/**
 * The poster as the browser decoded it: its natural size and mean colour,
 * read back off a canvas. The fixture's bucket is on the page's own origin, so
 * the canvas is not tainted. A blank box (no image, a 1×1 stand-in, white) fails.
 */
async function posterPixels(c: Locator): Promise<{ width: number; height: number; rgb: [number, number, number]; shown: number }> {
  const img = c.getByTestId("public-card-poster");
  await img.scrollIntoViewIfNeeded(); // loading="lazy": off-screen posters don't load
  await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth > 0), { timeout: 15_000 }).toBe(true);
  return img.evaluate((el: HTMLImageElement) => {
    const canvas = document.createElement("canvas");
    canvas.width = el.naturalWidth;
    canvas.height = el.naturalHeight;
    const ctx = canvas.getContext("2d")!;
    ctx.drawImage(el, 0, 0);
    const d = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    const sum = [0, 0, 0];
    for (let i = 0; i < d.length; i += 4) for (let k = 0; k < 3; k++) sum[k] += d[i + k];
    const n = d.length / 4;
    return {
      width: el.naturalWidth,
      height: el.naturalHeight,
      rgb: [sum[0] / n, sum[1] / n, sum[2] / n] as [number, number, number],
      shown: el.getBoundingClientRect().width,
    };
  });
}

/**
 * Publish a template under `key` straight through the fixture's site API —
 * prepare, the signed uploads, commit — built from the Green hook seed's own
 * files. The spec plays a second machine that published under this key, so
 * the template exists in the catalog with no local copy here.
 */
async function publishThroughFixture(request: APIRequestContext, key: string, name: string): Promise<string> {
  const seed = (await (await request.get(`${FIXTURE}/${GREEN}`)).json()) as { template: { files: Array<{ name: string; contentType: string }> } };
  const object = async (file: string) => {
    const res = await request.get(`${FIXTURE}/bucket/templates/${GREEN}/v1/${file}`);
    expect(res.ok(), `seed ${file}`).toBe(true);
    return res.body();
  };
  const description = "Published by the e2e spec from another machine.";
  const tags = ["e2e"];
  const scaffold = { ...(JSON.parse((await object("template.json")).toString("utf8")) as Record<string, unknown>), name, description, tags };
  const instructions = `# Purpose\n${name}.\n\n## Steps\n1. Fill the headline slot.\n`;
  const bodies: Record<string, Buffer> = {
    "template.json": Buffer.from(JSON.stringify(scaffold)),
    "index.md": Buffer.from(instructions),
    "poster.jpg": await object("poster.jpg"),
    "example.mp4": await object("example.mp4"),
  };
  const files = seed.template.files.map((f) => ({
    name: f.name,
    bytes: bodies[f.name].byteLength,
    contentType: f.contentType,
    md5: createHash("md5").update(bodies[f.name]).digest("base64"),
  }));
  const body = { schemaHash: SCAFFOLD_SCHEMA_SHA256, name, description, tags, scaffold, instructions, files, example: { durationSec: 3, width: 320, height: 240 } };
  const auth = { Authorization: `Bearer ${key}` };

  const prepared = await request.post(`${FIXTURE}/publish/prepare`, { data: body, headers: auth });
  expect(prepared.ok(), `prepare → ${await prepared.text()}`).toBe(true);
  const { templateId, version, uploads } = (await prepared.json()) as {
    templateId: string;
    version: number;
    uploads: Array<{ name: string; url: string; headers: Record<string, string> }>;
  };
  for (const u of uploads) {
    const put = await request.put(u.url, { headers: u.headers, data: bodies[u.name] });
    expect(put.status(), `upload ${u.name}`).toBe(200);
  }
  const committed = await request.post(`${FIXTURE}/publish/commit`, { data: { ...body, templateId, version }, headers: auth });
  expect(committed.ok(), `commit → ${await committed.text()}`).toBe(true);
  expect(await committed.json()).toMatchObject({ ok: true, templateId, indexed: true });
  return templateId;
}

/** Five distinct reporters in 24 h hide a template for moderation — the site's rule, and the fixture's. */
async function moderateAway(request: APIRequestContext, cloudId: string): Promise<void> {
  for (let i = 1; i <= 5; i++) {
    const res = await request.post(`${FIXTURE}/${cloudId}/report`, {
      data: { reason: "spam" },
      headers: { "x-libi-fixture-client": `e2e-moderation-${i}` },
    });
    expect(res.ok()).toBe(true);
  }
}

// ---------------------------------------------------------------------------

test.describe("Templates — the Public tab", () => {
  // Each test builds on the state the one before it left (see the header).
  test.describe.configure({ mode: "serial" });

  test("first open while the catalog fails says so, never 'no templates'; Refresh brings the catalog", async ({ page }) => {
    // A first open: whatever an earlier spec fetched is forgotten, and no fault is left queued.
    expect((await page.request.delete("/api/test-mode/catalog-cache")).ok()).toBe(true);
    expect((await page.request.post(`${FIXTURE}/_faults`, { data: { clear: true } })).ok()).toBe(true);
    await injectFault(page.request, "index", "internal");
    await openPublic(page);
    const offline = page.getByTestId("public-offline");
    await expect(offline).toBeVisible({ timeout: 15_000 });
    await expect(offline).toContainText("The catalog isn't answering properly right now, and libi has no copy of it yet.");
    await expect(page.getByTestId("public-tab-empty")).toHaveCount(0);
    await expect(page.getByTestId("public-status")).toHaveAttribute("data-error", "http_error");

    // The fault was one answer; the user's Refresh forces a fetch past the backoff.
    await page.getByTestId("public-refresh").click();
    await expect(page.getByTestId("public-card")).toHaveCount(3, { timeout: 15_000 });
    await expect(offline).toHaveCount(0);
    await expect(page.getByTestId("public-status")).not.toHaveAttribute("data-error", /.+/);
    await expect(page.getByTestId("public-status")).toContainText("Catalog updated");
  });

  test("the three seeds, trending first, with their author, counts and a poster that has pixels", async ({ page, request }) => {
    // Its own copy of the catalog, whatever the test before it left (a forced fetch, as Refresh does).
    expect((await request.post("/api/templates/cloud/catalog")).ok()).toBe(true);
    await openPublic(page);
    await expect(page.getByTestId("public-card")).toHaveCount(3);
    expect(await cardNames(page)).toEqual(SEED_NAMES);
    const green = card(page, "Green hook");
    await expect(green.getByTestId("public-card-nickname")).toHaveText("by fixture");
    await expect(green.getByTestId("public-card-uses")).toContainText("3 this week · 12 total");
    await expect(green.getByTestId("public-card-uses")).toContainText("1 slot");

    // The server fetched the index from the fixture: the media base it hands the page is loopback.
    const catalog = (await (await request.get("/api/templates/cloud/catalog")).json()) as { base: string; entries: unknown[] };
    expect(catalog.base).toBe(`http://127.0.0.1:${process.env.LIBI_E2E_PORT}${FIXTURE}/bucket/`);
    expect(catalog.entries).toHaveLength(3);

    // Each poster is its clip's first frame, decoded — not an empty box, not a
    // 1×1 or white stand-in (a QA round once saw three blank white cards).
    const expected: Record<string, (rgb: [number, number, number]) => boolean> = {
      "Green hook": ([r, g, b]) => g > 100 && r < 50 && b < 50,
      "Red caption": ([r, g, b]) => r > 200 && g < 50 && b < 50,
      "Vertical kinetic caption": ([r, g, b]) => b > 60 && b > r + 30 && g < 120,
    };
    const ids: Record<string, string> = { "Green hook": GREEN, "Red caption": RED, "Vertical kinetic caption": VERTICAL };
    for (const name of SEED_NAMES) {
      const c = card(page, name);
      await expect(c.getByTestId("public-card-poster")).toHaveAttribute("src", `${catalog.base}templates/${ids[name]}/v1/poster.jpg`);
      const px = await posterPixels(c);
      expect(Math.min(px.width, px.height), `${name} poster size`).toBeGreaterThanOrEqual(64);
      expect(px.shown, `${name} poster on screen`).toBeGreaterThan(50);
      expect(expected[name](px.rgb), `${name} poster colour ${px.rgb.map(Math.round).join(",")}`).toBe(true);
    }
  });

  test("search narrows through the FTS mirror, and the order select reorders", async ({ page, request }) => {
    // The seeds alone order trending and most-used alike, and newest as their
    // exact reverse. Five uses of the newest seed this week (five distinct
    // fixture clients: one counts per client per day) make every order its own,
    // and none the reverse of another:
    //   trending  (7-day uses)   Vertical 5, Green 3, Red 2
    //   most-used (all-time)     Green 12, Vertical 5, Red 2
    //   newest    (created)      Vertical 1 day, Red 3, Green 40
    for (let i = 1; i <= 5; i++) {
      const res = await request.post(`${FIXTURE}/${VERTICAL}/use`, { data: {}, headers: { "x-libi-fixture-client": `e2e-order-${i}` } });
      expect(res.ok()).toBe(true);
    }
    expect((await request.post("/api/templates/cloud/catalog")).ok()).toBe(true);
    await openPublic(page);
    const cards = page.getByTestId("public-card");
    await expect(cards).toHaveCount(3);

    await page.getByTestId("list-search").fill("kinetic");
    await expect(cards).toHaveCount(1);
    expect(await cardNames(page)).toEqual(["Vertical kinetic caption"]);
    // A word from the tags and names of two seeds.
    await page.getByTestId("list-search").fill("caption");
    await expect(cards).toHaveCount(2);
    expect((await cardNames(page)).sort()).toEqual(["Red caption", "Vertical kinetic caption"]);
    await page.getByTestId("list-search").fill("zzzz-nothing");
    await expect(page.getByTestId("public-no-match")).toBeVisible();
    await page.getByTestId("list-search").fill("");
    await expect(cards).toHaveCount(3);

    const TRENDING = ["Vertical kinetic caption", "Green hook", "Red caption"];
    await expect.poll(() => cardNames(page)).toEqual(TRENDING); // the default
    await chooseOrder(page, "newest");
    await expect.poll(() => cardNames(page)).toEqual(["Vertical kinetic caption", "Red caption", "Green hook"]);
    await expect(page.getByTestId("templates-order")).toContainText("Newest");
    await chooseOrder(page, "most-used");
    await expect.poll(() => cardNames(page)).toEqual(["Green hook", "Vertical kinetic caption", "Red caption"]);
    await expect(page.getByTestId("templates-order")).toContainText("Most used");
    await chooseOrder(page, "trending");
    await expect.poll(() => cardNames(page)).toEqual(TRENDING);
    await expect(page.getByTestId("templates-order")).toContainText("Trending");
  });

  test("hover plays the example muted from the fixture, leaving stops and rewinds it", async ({ page }) => {
    await openPublic(page);
    const green = card(page, "Green hook");
    const video = green.getByTestId("public-card-video");
    // Loaded only on hover: a grid must not open a stream per card.
    await expect(video).toBeHidden();
    expect(await video.getAttribute("src")).toBeNull();

    const clip = page.waitForRequest((r) => r.url().endsWith(`${FIXTURE}/bucket/templates/${GREEN}/v1/example.mp4`));
    await green.hover();
    await expect(video).toHaveAttribute("src", `http://127.0.0.1:${process.env.LIBI_E2E_PORT}${FIXTURE}/bucket/templates/${GREEN}/v1/example.mp4`);
    await clip;
    await expect(video).toBeVisible();
    await expect
      .poll(() => video.evaluate((v: HTMLVideoElement) => !v.paused && v.muted && v.currentTime > 0), { timeout: 15_000 })
      .toBe(true);

    // Leaving stops it, rewinds it, and gives the poster back.
    await page.getByRole("heading", { name: "Templates", exact: true }).hover();
    await expect
      .poll(() => video.evaluate((v: HTMLVideoElement) => v.paused && v.currentTime === 0), { timeout: 15_000 })
      .toBe(true);
    await expect(video).toBeHidden();
    await expect(green.getByTestId("public-card-poster")).toBeVisible();
  });

  test("Use installs the template once and hands the agent apply_template with the local id — no piece, no author text", async ({ page, request }) => {
    const piecesBefore = await pieceCount(request);
    expect((await localTemplates(request)).filter((t) => t.cloudId === RED)).toHaveLength(0);
    await openPublic(page);
    const red = card(page, "Red caption");
    const dialog = page.getByRole("dialog");

    await red.getByTestId("public-card-use").click();
    await expect(dialog).toBeVisible({ timeout: 30_000 });
    const installed = (await localTemplates(request)).filter((t) => t.cloudId === RED);
    expect(installed).toHaveLength(1);
    expect(installed[0]).toMatchObject({ origin: "installed", name: "Red caption" });
    const localId = installed[0].id;

    // The prompt goes out in the user's voice: the template by its local id,
    // and none of the stranger's words — name, nickname, description or tags.
    await expect(dialog).toContainText(`libi.apply_template({ templateId: "${localId}", newPiece: {} })`);
    await expect(dialog).toContainText(`the template with id ${localId} (installed from the public catalog)`);
    const text = ((await dialog.textContent()) ?? "").toLowerCase();
    for (const authored of ["Red caption", "fixture", "a fixture template for test mode"]) expect(text).not.toContain(authored.toLowerCase());

    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    // A hand-off, never a write: apply_template({ newPiece: {} }) makes the piece.
    expect(await pieceCount(request)).toBe(piecesBefore);

    // Use again: the same install (UNIQUE cloud_id), the same id in the prompt.
    await red.getByTestId("public-card-use").click();
    await expect(dialog).toBeVisible({ timeout: 30_000 });
    await expect(dialog).toContainText(`templateId: "${localId}"`);
    await page.keyboard.press("Escape");
    const after = await localTemplates(request);
    expect(after.filter((t) => t.cloudId === RED).map((t) => t.id)).toEqual([localId]);
    expect(after).toHaveLength(1);
    expect(await pieceCount(request)).toBe(piecesBefore);
    // Fetched from the catalog once: the second Use found the install in place.
    expect(fixtureTrace().filter((c) => c.tool === "get" && c.input.id === RED)).toHaveLength(1);

    // Mine lists it as installed, in the grid and in "Your templates".
    await openMine(page);
    await expect(page.getByTestId("template-card").filter({ hasText: "Red caption" })).toHaveCount(1);
    await page.getByTestId("templates-view-list").click();
    const row = page.getByTestId("templates-table-row").filter({ hasText: "Red caption" });
    await expect(row).toHaveAttribute("data-template-id", localId);
    await expect(row.getByTestId("templates-table-installed")).toHaveText("Installed");
  });

  test("Report sends the chosen fixed reason and the typed details once, says what a report does, and is remembered", async ({ page }) => {
    await openPublic(page);
    const vertical = card(page, "Vertical kinetic caption");
    await vertical.getByTestId("report-trigger").click();
    // The fixed reasons; free text only in the dialog's optional details box.
    await expect(page.getByRole("menuitem")).toHaveText(["Spam", "Offensive", "Broken", "Copyright", "Other"]);
    // By its label, as the user picks it: the payload below is what must name the reason.
    await page.getByRole("menuitem", { name: "Broken", exact: true }).click();

    const confirm = page.getByRole("alertdialog");
    await expect(confirm).toContainText("Report this template: Broken?");
    await expect(confirm).toContainText("without your name or creator key");
    await expect(confirm).toContainText("five different people report a template within 24 hours");
    // Only a copyright report points at the web form.
    await expect(confirm.getByTestId("report-copyright-form")).toHaveCount(0);
    await confirm.getByLabel("Add details (optional)").fill("  The example never plays.  ");
    const sent = page.waitForRequest((r) => r.url().endsWith("/api/templates/cloud/report") && r.method() === "POST");
    await page.getByTestId("report-confirm").click();
    expect((await sent).postDataJSON()).toEqual({ cloudId: VERTICAL, reason: "broken", details: "The example never plays." });

    await expect(page.getByText("Thanks — reported.", { exact: true })).toBeVisible();
    await expect(vertical.getByTestId("report-done")).toHaveText("Reported");
    await expect(vertical.getByTestId("report-trigger")).toHaveCount(0);
    // It reached the catalog — the fixture, once, with the fixed reason (the trace says details came, never the text).
    const reports = fixtureTrace().filter((c) => c.tool === "report");
    expect(reports).toEqual([expect.objectContaining({ input: { id: VERTICAL, reason: "broken", hasDetails: true }, status: 200 })]);

    // Remembered on this install: no second report is offered after a reload.
    await page.reload();
    await expect(card(page, "Vertical kinetic caption").getByTestId("report-done")).toHaveText("Reported", { timeout: 30_000 });
    await expect(card(page, "Green hook").getByTestId("report-trigger")).toBeVisible();
  });

  test("Publishing as: a nickname is set inline, held to the site's rule, and reaches the catalog", async ({ page, request }) => {
    await openPublic(page);
    const header = page.getByTestId("publishing-as");
    const edit = page.getByTestId("publishing-as-edit");
    // Every user has a nickname from the first view: a random default until they rename it.
    await expect(edit).toHaveText(/^[A-Z][a-z]+ [A-Z][a-z]+ [1-9]\d{3}$/);
    await edit.click();
    const input = page.getByTestId("nickname-input");
    // What the page itself sends to set a nickname (its GET of the current one aside).
    const isWrite = (r: Request) => new URL(r.url()).pathname === "/api/templates/cloud/author" && r.method() !== "GET";
    const writes: Array<{ method: string; body: unknown }> = [];
    page.on("request", (r) => {
      if (isWrite(r)) writes.push({ method: r.method(), body: r.postDataJSON() });
    });

    await input.fill("x");
    await expect(page.getByTestId("nickname-error")).toBeVisible();
    // Nothing leaves the page: not a request libi's route would refuse, not one
    // that reaches the catalog. A UI that sent one would do it on the keypress,
    // well inside this window.
    const sent = page.waitForRequest(isWrite, { timeout: 2_000 }).then(
      () => true,
      () => false,
    );
    await input.press("Enter");
    expect(await sent, "Enter on an invalid nickname sent a request").toBe(false);
    await expect(input).toBeVisible(); // refused locally: still editing
    expect(writes).toEqual([]);
    expect(fixtureTrace().filter((c) => c.tool === "authors_me")).toHaveLength(0);

    await input.fill(NICKNAME);
    await expect(page.getByTestId("nickname-error")).toHaveCount(0);
    await input.press("Enter");
    await expect(input).toHaveCount(0);
    await expect(edit).toHaveText(NICKNAME);
    // The spy sees a write when there is one: exactly this one.
    expect(writes).toEqual([{ method: "PUT", body: { nickname: NICKNAME } }]);
    expect(fixtureTrace().filter((c) => c.tool === "authors_me")).toEqual([expect.objectContaining({ input: { nickname: NICKNAME }, status: 200 })]);
    // The catalog's own answer for this key, through libi's route.
    expect(((await (await request.get("/api/templates/cloud/mine")).json()) as { nickname: string }).nickname).toBe(NICKNAME);

    await page.reload();
    await expect(header).toContainText("Publishing as", { timeout: 30_000 });
    await expect(edit).toHaveText(NICKNAME);
  });

  test("Your templates: a template published under this key with no local copy lists, hides and shows again", async ({ page, request }) => {
    // No local templates at all: the install from the Use test goes.
    for (const t of await localTemplates(request)) expect((await request.delete(`/api/templates/${t.id}`)).ok()).toBe(true);
    expect(await localTemplates(request)).toHaveLength(0);

    // This install's creator key (made by the nickname, or here), and a template
    // published under it from "another machine".
    const author = await request.put("/api/templates/cloud/author", { data: { nickname: NICKNAME }, headers: asThePage() });
    expect(author.ok(), await author.text()).toBe(true);
    // The reveal answers only the page's own same-origin request (browserOnlyRefusal): the spec poses as it.
    const revealed = await request.post("/api/templates/cloud/key/reveal", { headers: asThePage() });
    expect(revealed.ok(), await revealed.text()).toBe(true);
    const key = ((await revealed.json()) as { key: string }).key;
    const cloudId = await publishThroughFixture(request, key, PUBLISHED_NAME);

    await openMine(page);
    await expect(page.getByTestId("templates-none-local")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("templates-empty")).toHaveCount(0);
    const row = page.getByTestId("templates-table-row");
    await expect(row).toHaveCount(1);
    await expect(row).toHaveAttribute("data-cloud-id", cloudId);
    await expect(row).toContainText(PUBLISHED_NAME);
    await expect(row.getByTestId("templates-table-not-here")).toHaveText("Not on this machine");
    const visibility = row.getByTestId(`template-visibility-${cloudId}`);
    await expect(visibility).toHaveAttribute("data-state", "public");

    await visibility.getByRole("button", { name: "Hide", exact: true }).click();
    await expect(visibility).toHaveAttribute("data-state", "hidden");
    await expect(visibility).toContainText("Hidden");
    // Out of the catalog itself, not just relabelled here.
    const hidden = (await (await request.post("/api/templates/cloud/catalog")).json()) as { entries: Array<{ cloudId: string }> };
    expect(hidden.entries.map((e) => e.cloudId)).not.toContain(cloudId);

    await visibility.getByRole("button", { name: "Show again", exact: true }).click();
    await expect(visibility).toHaveAttribute("data-state", "public");
    const shown = (await (await request.post("/api/templates/cloud/catalog")).json()) as { entries: Array<{ cloudId: string; nickname: string }> };
    expect(shown.entries.find((e) => e.cloudId === cloudId)?.nickname).toBe(NICKNAME);
    expect(fixtureTrace().filter((c) => c.tool === "visibility").map((c) => c.input.hidden)).toEqual([true, false]);
  });

  test("a failing catalog keeps the copy on screen; an empty catalog says so; failing with nothing says it's offline", async ({ page, request }) => {
    await openPublic(page);
    const cards = page.getByTestId("public-card");
    await expect(cards).toHaveCount(4); // the seeds and the one published above
    const status = page.getByTestId("public-status");

    // Offline with a copy: the cards stay, and the status says how old they are.
    await injectFault(request, "index", "internal");
    await page.getByTestId("public-refresh").click();
    await expect(status).toHaveAttribute("data-error", "http_error");
    await expect(status).toContainText("The catalog isn't answering properly right now — showing the copy from");
    await expect(cards).toHaveCount(4);

    // Every template leaves the catalog (moderation); the refresh brings an empty list.
    const listed = (await (await request.get("/api/templates/cloud/catalog")).json()) as { entries: Array<{ cloudId: string }> };
    for (const e of listed.entries) await moderateAway(request, e.cloudId);
    await page.getByTestId("public-refresh").click();
    const empty = page.getByTestId("public-tab-empty");
    await expect(empty).toBeVisible({ timeout: 15_000 });
    await expect(empty).toHaveText("No public templates yet. Publish one of yours from the Mine tab to be the first.");
    await expect(cards).toHaveCount(0);
    await expect(status).not.toHaveAttribute("data-error", /.+/);
    await expect(page.getByTestId("public-offline")).toHaveCount(0);

    // Empty and offline are not the same thing, and are not shown the same way.
    await injectFault(request, "index", "internal");
    await page.getByTestId("public-refresh").click();
    const offline = page.getByTestId("public-offline");
    await expect(offline).toBeVisible();
    await expect(offline).toContainText("The catalog isn't answering properly right now, and libi has no copy of it yet.");
    await expect(empty).toHaveCount(0);
  });
});
