import path from "path";
import type { APIRequestContext, APIResponse } from "@playwright/test";
import { test, expect } from "./helpers/app";

/**
 * Final review I1: stored bytes served from libi's origin must never run as
 * libi. This asserts the FINAL response headers through the real server — the
 * proxy included. The route tests call a handler directly and cannot see that
 * Next keeps the proxy's CSP over the route's, which is how the template media
 * route's SVG sandbox CSP was silently inert.
 *
 * The `hostile-media` fixture carries an SVG with a `<script>` and an HTML file
 * named `page.png` whose template.json claims `text/html`, beside an ordinary
 * PNG and MP4 that must keep rendering when embedded.
 */
const FIXTURE = path.resolve(__dirname, "..", "__tests__", "helpers", "fixtures", "templates", "hostile-media");
const MEDIA_CSP = "default-src 'none'; sandbox";

async function seed(request: APIRequestContext): Promise<string> {
  const res = await request.post("/api/e2e/seed-template", { data: { dir: FIXTURE } });
  expect(res.ok(), `seed-template → HTTP ${res.status()} ${await res.text()}`).toBe(true);
  return ((await res.json()) as { templateId: string }).templateId;
}

/** Apply the fixture into a fresh piece: its id, and filename → file id of what it stored. */
async function applyIntoNewPiece(
  request: APIRequestContext,
  templateId: string,
): Promise<{ pieceId: string; fileIds: Record<string, string> }> {
  const res = await request.post("/api/e2e/run-tool", {
    data: { tool: "libi.apply_template", args: { templateId, newPiece: { name: "Hostile media" } } },
  });
  const body = (await res.json()) as { success: boolean; data?: { pieceId: string } };
  expect(body.success, JSON.stringify(body)).toBe(true);
  const files = await request.get(`/api/pieces/${body.data!.pieceId}/files`);
  const rows = ((await files.json()) as { files: Array<{ id: string; filename: string }> }).files;
  return { pieceId: body.data!.pieceId, fileIds: Object.fromEntries(rows.map((f) => [f.filename, f.id])) };
}

/** What a hosted `https://…/x.svg` that declared `image/png` leaves behind: a
 *  row typed `image/png` under the filename `x.svg`. An upload stores exactly
 *  that (the declared type, the given name) without a network fetch. */
async function storeSvgNamedPng(request: APIRequestContext, pieceId: string): Promise<void> {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><script>document.title="pwned";alert(1)</script></svg>`;
  const res = await request.post(`/api/pieces/${pieceId}/upload`, {
    multipart: { file: { name: "x.svg", mimeType: "image/png", buffer: Buffer.from(svg) } },
  });
  expect(res.ok(), `upload → HTTP ${res.status()} ${await res.text()}`).toBe(true);
  const stored = ((await res.json()) as { file: { filename: string; contentType: string } }).file;
  expect(stored).toMatchObject({ filename: "x.svg", contentType: "image/png" });
}

function headersOf(res: APIResponse) {
  const h = res.headers();
  return { type: h["content-type"], csp: h["content-security-policy"], nosniff: h["x-content-type-options"], disposition: h["content-disposition"] };
}

test.describe("media responses from libi's origin", () => {
  let templateId: string;
  let pieceId: string;
  let fileIds: Record<string, string>;

  test.beforeAll(async ({ request }) => {
    templateId = await seed(request);
    ({ pieceId, fileIds } = await applyIntoNewPiece(request, templateId));
    await storeSvgNamedPng(request, pieceId);
  });

  test.afterAll(async ({ request }) => {
    await request.post("/api/e2e/run-tool", { data: { tool: "libi.delete_template", args: { templateId } } });
  });

  test("template media: an SVG gets the sandbox CSP and nosniff, a PNG the media CSP", async ({ request }) => {
    const svg = headersOf(await request.get(`/api/templates/${templateId}/media/logo.svg`));
    expect(svg).toMatchObject({ type: "image/svg+xml", csp: MEDIA_CSP, nosniff: "nosniff" });
    const png = headersOf(await request.get(`/api/templates/${templateId}/media/real.png`));
    expect(png).toMatchObject({ type: "image/png", csp: MEDIA_CSP, nosniff: "nosniff" });
  });

  test("file content: the asset template.json called text/html is stored and served as image/png", async ({ request }) => {
    expect(Object.keys(fileIds).sort()).toEqual(["clip.mp4", "logo.svg", "page.png", "real.png"]);
    const page = headersOf(await request.get(`/api/files/by-id/${fileIds["page.png"]}/content`));
    expect(page).toMatchObject({ type: "image/png", csp: MEDIA_CSP, nosniff: "nosniff" });
    const svg = headersOf(await request.get(`/api/files/by-id/${fileIds["logo.svg"]}/content`));
    expect(svg).toMatchObject({ type: "image/svg+xml", csp: MEDIA_CSP, nosniff: "nosniff" });
    const clip = headersOf(await request.get(`/api/files/by-id/${fileIds["clip.mp4"]}/content`));
    expect(clip).toMatchObject({ type: "video/mp4", csp: MEDIA_CSP, nosniff: "nosniff" });
    expect(clip.disposition).toBeUndefined();
    // Pages keep the page CSP.
    const editor = headersOf(await request.get("/templates"));
    expect(editor.csp).toContain("script-src 'self'");
  });

  // Final re-review 1, I1: the by-FILENAME route serves the same bytes and
  // took its type from the name, with the page CSP and no nosniff.
  test("piece file by filename: the SVG is sandboxed, and x.svg stored as image/png is a PNG", async ({ request }) => {
    const svg = headersOf(await request.get(`/api/files/${pieceId}/logo.svg`));
    expect(svg).toMatchObject({ type: "image/svg+xml", csp: MEDIA_CSP, nosniff: "nosniff" });
    const named = headersOf(await request.get(`/api/files/${pieceId}/x.svg`));
    expect(named).toMatchObject({ type: "image/png", csp: MEDIA_CSP, nosniff: "nosniff" });
    const png = headersOf(await request.get(`/api/files/${pieceId}/page.png`));
    expect(png).toMatchObject({ type: "image/png", csp: MEDIA_CSP, nosniff: "nosniff" });
  });

  test("opening the hostile URLs runs no script", async ({ page }) => {
    const dialogs: string[] = [];
    page.on("dialog", async (d) => {
      dialogs.push(d.message());
      await d.dismiss();
    });
    for (const url of [
      `/api/templates/${templateId}/media/logo.svg`,
      `/api/files/by-id/${fileIds["logo.svg"]}/content`,
      `/api/files/by-id/${fileIds["page.png"]}/content`,
      `/api/files/${pieceId}/logo.svg`,
      `/api/files/${pieceId}/x.svg`,
      `/api/files/${pieceId}/page.png`,
    ]) {
      await page.goto(url);
      await page.waitForTimeout(300);
      expect(await page.title(), url).not.toBe("pwned");
    }
    expect(dialogs).toEqual([]);
  });

  test("embedded in an app page, the same media still renders", async ({ page }) => {
    await page.goto("/templates");
    await expect(page.getByRole("heading", { name: "Templates", exact: true })).toBeVisible({ timeout: 30_000 });
    const result = await page.evaluate(
      async ({ templateId, fileIds, pieceId }) => {
        const img = (src: string) =>
          new Promise<number>((resolve) => {
            const el = new Image();
            el.onload = () => resolve(el.naturalWidth);
            el.onerror = () => resolve(-1);
            el.src = src;
          });
        const video = (src: string) =>
          new Promise<number>((resolve) => {
            const el = document.createElement("video");
            el.muted = true;
            el.preload = "metadata";
            el.onloadedmetadata = () => resolve(el.videoWidth);
            el.onerror = () => resolve(-1);
            el.src = src;
            document.body.appendChild(el);
          });
        return {
          mediaPng: await img(`/api/templates/${templateId}/media/real.png`),
          mediaSvg: await img(`/api/templates/${templateId}/media/logo.svg`),
          contentPng: await img(`/api/files/by-id/${fileIds["real.png"]}/content`),
          contentSvg: await img(`/api/files/by-id/${fileIds["logo.svg"]}/content`),
          contentVideo: await video(`/api/files/by-id/${fileIds["clip.mp4"]}/content`),
          byNamePng: await img(`/api/files/${pieceId}/real.png`),
          byNameSvg: await img(`/api/files/${pieceId}/logo.svg`),
          byNameVideo: await video(`/api/files/${pieceId}/clip.mp4`),
        };
      },
      { templateId, fileIds, pieceId },
    );
    expect(result.mediaPng).toBe(64);
    expect(result.contentPng).toBe(64);
    expect(result.mediaSvg).toBe(64);
    expect(result.contentSvg).toBe(64);
    expect(result.contentVideo).toBeGreaterThan(0);
    expect(result.byNamePng).toBe(64);
    expect(result.byNameSvg).toBe(64);
    expect(result.byNameVideo).toBeGreaterThan(0);
  });
});

/**
 * Merge of feat/templates-sandbox: the app CSP gained `frame-ancestors`, and
 * `frame-ancestors 'none'` once blanked the editor's same-origin PDF `<embed>`
 * (asset-media-view.tsx) — Chromium enforces it on an embed. A stored PDF is
 * now served with the media CSP instead, which carries no `frame-ancestors`.
 *
 * Launches the FULL Chromium (`channel: "chromium"`) itself: the default
 * headless shell has no PDF viewer, so an embed there loads nothing and would
 * prove nothing, and `test.use({ channel })` cannot be scoped to one group.
 *
 * What "rendered" means here, measured against a plain server on 2026-09-24:
 * an embed whose response Chromium refuses to frame logs "Framing … violates
 * … frame-ancestors" and its frame becomes `chrome-error://chromewebdata/`; one
 * it renders gets the PDF viewer's `chrome-extension://…/index.html` frame. (A
 * `page.route` fulfilment is NOT a usable control — Chromium does not enforce
 * `frame-ancestors` on an intercepted response, so it always "renders".)
 */
test.describe("a stored PDF in the asset viewer's <embed>", () => {
  test("renders in the PDF viewer under the app page's CSP", async ({ playwright, request, baseURL }) => {
    const templateId = await seed(request);
    const { pieceId } = await applyIntoNewPiece(request, templateId);
    const pdf = Buffer.from(
      "%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n" +
        "3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n",
    );
    const up = await request.post(`/api/pieces/${pieceId}/upload`, {
      multipart: { file: { name: "doc.pdf", mimeType: "application/pdf", buffer: pdf } },
    });
    expect(up.ok(), `upload → HTTP ${up.status()} ${await up.text()}`).toBe(true);
    const fileId = ((await up.json()) as { file: { id: string } }).file.id;
    const url = `/api/files/by-id/${fileId}/content`;

    const served = headersOf(await request.get(url));
    expect(served).toMatchObject({ type: "application/pdf", csp: MEDIA_CSP, nosniff: "nosniff" });

    const browser = await playwright.chromium.launch({ channel: "chromium" });
    try {
      const page = await (await browser.newContext({ baseURL })).newPage();
      const refusals: string[] = [];
      page.on("console", (m) => {
        if (/frame-ancestors|Refused to (frame|load|display)/i.test(m.text())) refusals.push(m.text());
      });
      await page.goto("/templates");
      await expect(page.getByRole("heading", { name: "Templates", exact: true })).toBeVisible({ timeout: 30_000 });
      const pageCsp = headersOf(await page.request.get("/templates")).csp;
      expect(pageCsp).toContain("object-src 'self'");

      // Exactly the asset viewer's element.
      await page.evaluate((src) => {
        const el = document.createElement("embed");
        el.type = "application/pdf";
        el.src = src;
        el.style.width = "300px";
        el.style.height = "300px";
        document.body.appendChild(el);
      }, url);

      await expect
        .poll(() => page.frames().some((f) => f.url().startsWith("chrome-extension://") && f.parentFrame()?.url().endsWith(url)), {
          message: "the PDF viewer never mounted inside the embed",
          timeout: 15_000,
        })
        .toBe(true);
      expect(page.frames().map((f) => f.url()).filter((u) => u.startsWith("chrome-error://"))).toEqual([]);
      expect(refusals).toEqual([]);
    } finally {
      await browser.close();
      await request.post("/api/e2e/run-tool", { data: { tool: "libi.delete_template", args: { templateId } } });
    }
  });
});
