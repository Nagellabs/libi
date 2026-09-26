import { createHash, randomBytes } from "crypto";
import fs from "fs";
import path from "path";
import type { APIRequestContext, Page } from "@playwright/test";
import { asThePage, test, expect, fixturePath } from "./helpers/app";

/**
 * "An agent can prepare a publish. Only you can publish." (2026-09-24.)
 *
 * The agent's `libi.publish_template` (through `/api/e2e/run-tool`, the agent's
 * own code path) makes the request's own example and poster (the real
 * `template_publish_prepare` job and ffmpeg), records a publish request and
 * sends nothing; the Templates page shows it as a review panel over the one
 * SSE, without a reload, playing exactly that example. Then:
 *   1. review → Publish publicly: the real `template_publish` job runs against
 *      test mode's fixture catalog (prepare, uploads, commit) with the very
 *      example bytes the panel played, and the panel goes once the template is
 *      in the catalog;
 *   2. review → Don't publish: the request is gone and the catalog heard
 *      nothing;
 *   and the confirm route refuses a request that is not the page's own.
 *
 * Serial against one spawned libi (playwright.config.ts). Nothing here may reach
 * the real catalog: every page request for it is aborted and fails the test; the
 * server's own calls are read from the fixture's call trace.
 */

const REAL_CATALOG = /^https?:\/\/([^/]*\.)?(storage\.googleapis\.com|nagellabs\.com)(:\d+)?(\/|$)/i;
const EXAMPLE = fixturePath(path.join("video", "vertical-9x16-3s.mp4"));

let leaked: string[] = [];
let traceStart = 0;

function traceFile(): string {
  return path.join(process.env.LIBI_E2E_HOME!, "test-mode", "templates-catalog-calls.jsonl");
}
/** What the fixture catalog served since the running test began. */
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
const calls = (tool: string) => fixtureTrace().filter((c) => c.tool === tool);

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
  // Later specs (e2e/templates.spec.ts) expect an empty library: no local
  // template, and a creator key that has published nothing ("Your templates"
  // lists a template this key published even with no local copy).
  const request = await playwright.request.newContext({ baseURL: `http://127.0.0.1:${process.env.LIBI_E2E_PORT}` });
  try {
    const res = await request.get("/api/templates?scope=local");
    for (const t of ((await res.json()) as { templates: Array<{ id: string }> }).templates) await request.delete(`/api/templates/${t.id}`);
    await request.put("/api/templates/cloud/key", { data: { key: randomBytes(32).toString("base64url"), replace: true }, headers: asThePage() });
  } finally {
    await request.dispose();
  }
});

async function runTool(request: APIRequestContext, tool: string, args: Record<string, unknown>) {
  const res = await request.post("/api/e2e/run-tool", { data: { tool, args } });
  const body = (await res.json()) as { success: boolean; data?: Record<string, unknown>; error?: string };
  expect(res.ok(), `${tool} → HTTP ${res.status()} ${JSON.stringify(body)}`).toBe(true);
  return body;
}

/** A template captured the way an agent captures one, from an empty piece. */
async function makeTemplate(request: APIRequestContext, name: string): Promise<string> {
  const piece = await request.post("/api/pieces");
  expect(piece.ok()).toBe(true);
  const pieceId = ((await piece.json()) as { id: string }).id;
  const r = await runTool(request, "libi.create_template_from_piece", { pieceId, name, description: "A hook for the publish review", tags: ["hook"] });
  expect(r.success, JSON.stringify(r)).toBe(true);
  return (r.data as { templateId: string }).templateId;
}

/** The agent prepares a publish: a request, and nothing else. */
async function prepare(request: APIRequestContext, templateId: string): Promise<string> {
  const r = await runTool(request, "libi.publish_template", { templateId, exampleVideo: { path: EXAMPLE }, confirm: true });
  expect(r.success, JSON.stringify(r)).toBe(true);
  expect(r.data).toMatchObject({ status: "awaiting_your_confirmation", message: "Ready for you to publish. Open Templates in libi and click Publish — I can't publish it for you." });
  expect(JSON.stringify(r)).not.toMatch(/confirmCode/);
  return (r.data as { requestId: string }).requestId;
}

async function openTemplates(page: Page, query = ""): Promise<void> {
  await page.goto(`/templates${query}`);
  await expect(page.getByRole("heading", { name: "Templates", exact: true })).toBeVisible({ timeout: 30_000 });
}

test.describe.configure({ mode: "serial" });

test.describe("Templates: an agent prepares, only you publish", () => {
  test("setup: a nickname to publish under", async ({ request }) => {
    const res = await request.put("/api/templates/cloud/author", { data: { nickname: "e2e-review" }, headers: asThePage() });
    expect(res.ok(), await res.text()).toBe(true);
  });

  test("review → Publish publicly: the job publishes to the fixture catalog, and the panel goes", async ({ page, request }) => {
    const templateId = await makeTemplate(request, "E2E review publish");
    await openTemplates(page);
    await expect(page.getByTestId("publish-reviews")).toHaveCount(0);

    const requestId = await prepare(request, templateId);
    // Over the SSE, no reload.
    const panel = page.getByTestId(`publish-review-${requestId}`);
    await expect(panel).toBeVisible({ timeout: 15_000 });
    // Preparing sent nothing anywhere.
    expect(calls("prepare")).toHaveLength(0);
    expect(calls("commit")).toHaveLength(0);

    await expect(panel.getByTestId("publish-review-name")).toHaveText("E2E review publish");
    await expect(panel.getByTestId("publish-review-public-items")).toContainText("The example video and poster frame shown here");
    // The panel plays the request's OWN example and shows its poster.
    const mediaBase = `/api/templates/cloud/publish-requests/${requestId}/media`;
    await expect(panel.getByTestId("publish-review-example")).toHaveAttribute("src", `${mediaBase}/example.mp4`);
    await expect(panel.getByTestId("publish-review-poster")).toHaveAttribute("src", `${mediaBase}/poster.jpg`);
    const shown = await request.get(`${mediaBase}/example.mp4`);
    expect(shown.status()).toBe(200);
    const shownMd5 = createHash("md5").update(await shown.body()).digest("base64");
    const poster = await request.get(`${mediaBase}/poster.jpg`);
    expect(poster.headers()["content-type"]).toBe("image/jpeg");
    const posterMd5 = createHash("md5").update(await poster.body()).digest("base64");
    await expect(panel.getByTestId("publish-review-public-items")).toContainText("e2e-review");
    await expect(panel.getByTestId("publish-review-warning")).toHaveText(
      "Publishing makes this public. Anyone can install it; unpublishing doesn't recall copies already installed.",
    );
    await expect(panel.getByTestId("publish-review-terms")).toHaveAttribute("href", /\/terms#templates-catalog$/);

    // The confirm route answers only the page's own request: a direct call — the agent's shell — is refused.
    const direct = await request.post(`/api/templates/cloud/publish-requests/${requestId}/confirm`, { data: { confirmCode: "guess" } });
    expect(direct.status()).toBe(403);
    // …and so is POST /api/jobs, for everyone.
    const viaJobs = await request.post("/api/jobs", { data: { kind: "template_publish", params: { templateId, requestId, reviewedFingerprint: "0".repeat(64) } } });
    expect(viaJobs.status()).toBe(403);
    expect(calls("prepare")).toHaveLength(0);

    // Publish needs the rights box ticked, every time, and arms only after the settle delay (PUBLISH_ARM_DELAY_MS).
    await expect(panel.getByTestId("publish-review-publish")).toBeDisabled();
    await panel.getByTestId("publish-review-rights").click();
    await expect(panel.getByTestId("publish-review-publish")).toBeEnabled();
    await panel.getByTestId("publish-review-publish").click();
    // The wait is named on the button while the job runs (it may finish quickly on a warm machine).
    await expect(panel).toHaveCount(0, { timeout: 120_000 });
    expect(calls("prepare")).toHaveLength(1);
    expect(calls("commit").filter((c) => c.status === 200)).toHaveLength(1);
    expect(calls("prepare")[0].input).toMatchObject({ name: "E2E review publish" });
    // What went out is exactly what the panel played: the published template's
    // example and poster (the bytes the fixture's commit checked against the
    // manifest) are the request's own, byte for byte.
    const md5Of = async (url: string) => createHash("md5").update(await (await request.get(url)).body()).digest("base64");
    expect(await md5Of(`/api/templates/${templateId}/media/example.mp4`)).toBe(shownMd5);
    expect(await md5Of(`/api/templates/${templateId}/media/poster.jpg`)).toBe(posterMd5);
    // Published: the request and its folder are gone.
    expect((await request.get(`${mediaBase}/example.mp4`)).status()).toBe(404);

    // The template is now the published one.
    const res = await request.get("/api/templates?scope=local");
    const row = ((await res.json()) as { templates: Array<{ id: string; cloudId: string | null }> }).templates.find((t) => t.id === templateId);
    expect(row?.cloudId).toMatch(/^[a-z2-7]{20}$/);

    // A-F live check N1: this page read the catalog when it opened, before the publish, and that copy is
    // well inside its 10 minutes. The Public tab lists the new template anyway, with no Refresh: the
    // publish made the copy stale (catalog-cache.ts#noteOwnCatalogChange) and the job's end re-read it.
    await page.getByTestId("templates-tab-public").click();
    await expect(page.locator(`[data-testid="public-card"][data-cloud-id="${row!.cloudId}"]`)).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("public-tab-empty")).toHaveCount(0);
  });

  test("review → Don't publish: the request is gone and the catalog heard nothing", async ({ page, request }) => {
    const templateId = await makeTemplate(request, "E2E review discard");
    const requestId = await prepare(request, templateId);
    await openTemplates(page, `?tab=mine&review=${requestId}`);
    const panel = page.getByTestId(`publish-review-${requestId}`);
    await expect(panel).toBeVisible({ timeout: 15_000 });
    await panel.getByTestId("publish-review-discard").click();
    await expect(panel).toHaveCount(0, { timeout: 15_000 });
    await expect(page.getByTestId("publish-reviews")).toHaveCount(0);
    expect(calls("prepare")).toHaveLength(0);
    expect(calls("commit")).toHaveLength(0);
    const list = await request.get("/api/templates/cloud/publish-requests");
    expect(((await list.json()) as { requests: unknown[] }).requests).toEqual([]);
  });
});
