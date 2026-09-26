import { test as base, expect, type APIRequestContext, type Page } from "@playwright/test";
import { execFileSync } from "child_process";
import fs from "fs";
import path from "path";

export { expect };

/** Path to the committed test fixture (`__tests__/helpers/fixtures/tiny.mp4`). */
export function fixturePath(name: string): string {
  return path.resolve(__dirname, "..", "..", "__tests__", "helpers", "fixtures", name);
}

/**
 * Answers the first-launch persona question through the product route. A home
 * that never answered it is a first launch: `/editor` is routed to the Agents tab,
 * and the question sits over every Agents page, in front of whatever a spec means
 * to click. playwright.config.ts gives each run a fresh home unless LIBI_E2E_HOME
 * is set, so no spec may count on an earlier one having answered it.
 */
export async function answerPersona(request: APIRequestContext): Promise<void> {
  const res = await request.put("/api/onboarding/persona", { data: { persona: "developer" } });
  expect(res.ok()).toBe(true);
}

/**
 * `test` for every spec that opens a libi page: each test starts as a user who
 * has already answered the persona question, whichever spec runs first, or alone.
 * The first-launch test in agents-page.spec.ts undoes that inside its own body and
 * puts it back when it finishes.
 */
export const test = base.extend<{ personaAnswered: void }>({
  personaAnswered: [
    async ({ request }, use) => {
      await answerPersona(request);
      await use();
    },
    { auto: true },
  ],
});

/**
 * Open `pieceId` in the editor, on its Timeline tab (`preview`), and wait for it to be
 * interactive (`data-testid="editor-panel"` exists only while a piece is open).
 *
 * A bare `/editor` opens NO piece in a browser that has never opened one: it
 * restores `lastPieceId` from localStorage (`lib/editor-state-context.tsx`) and
 * otherwise shows the "No piece open" empty state, by design
 * (`app/(app)/editor/page.tsx`, the restore effect). A spec's fresh browser
 * context has no such entry, so the piece is seeded there — `addInitScript`
 * runs before the app's first script on every navigation, reloads included —
 * which is the same restore path a returning user's browser takes. Not the
 * `?piece=` deep link: that one opens the piece on its Posting tab.
 *
 * Answers the persona question first, so it also serves specs that import
 * `test` from Playwright itself.
 */
export async function openEditor(page: Page, pieceId: string): Promise<void> {
  await answerPersona(page.request);
  await page.addInitScript(
    ({ pieceId }) => {
      try {
        const key = "libi:editor-state";
        const saved = JSON.parse(window.localStorage.getItem(key) ?? "{}") as Record<string, unknown>;
        // Seed only when this piece isn't the one saved already: on a reload the
        // app's own saved state (tab, open panels) is what a returning user has.
        if (saved.lastPieceId !== pieceId) {
          window.localStorage.setItem(key, JSON.stringify({ ...saved, lastPieceId: pieceId, lastEditorTab: "preview" }));
        }
      } catch {
        // A sandboxed (opaque-origin) frame has no localStorage; the script runs there too.
      }
    },
    { pieceId },
  );
  await page.goto("/editor");
  await expect(page.locator("[data-testid=\"editor-panel\"]")).toBeVisible({
    timeout: 30_000,
  });
}

/**
 * Show the resources panel (asset rows, the upload input). It is hidden by
 * default for a new user (`resourcesVisible: false`, lib/editor-state-context.tsx);
 * this is the editor header's own toggle, and the choice persists across reloads.
 */
export async function showResources(page: Page): Promise<void> {
  await page.getByTitle("Show resources").click();
  await expect(page.getByTitle("Hide resources")).toBeVisible();
}

/**
 * Call a libi tool through the test-only `/api/e2e/run-tool` route and fail
 * the spec unless it succeeded.
 *
 * The route validates the args exactly as libi's MCP endpoint validates an
 * agent's (`lib/e2e/run-tool-input.ts`) and refuses bad ones with HTTP 400 and
 * the agent's own refusal text; a tool that no longer exists is a 404. Before
 * it did, a seed missing a required field was persisted as `undefined` and
 * the spec failed later, somewhere unrelated — so read the answer.
 */
export async function runTool(
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

/** A media file's duration in seconds, read with ffprobe. */
export function probeDurationSeconds(filePath: string): number {
  const out = execFileSync(
    "ffprobe",
    ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", filePath],
    { encoding: "utf8" },
  ).trim();
  const seconds = Number(out);
  if (!Number.isFinite(seconds) || seconds <= 0) throw new Error(`ffprobe gave no duration for ${filePath}: ${JSON.stringify(out)}`);
  return seconds;
}

/**
 * Create a piece at `width`×`height` holding one uploaded fixture video as a
 * full-frame video overlay from 0 for its whole length — the shape an agent's
 * `libi.add_overlay({ kind: "video" })` makes.
 *
 * The frame is set explicitly because a new piece takes the user's default
 * aspect ratio, and specs that click or sample the canvas by coordinates need
 * to know it. It is set through `PATCH /api/pieces/:id/composition/dimensions`,
 * the route the editor uses for a piece with no overlays yet.
 */
export async function seedPieceWithVideo(
  request: APIRequestContext,
  opts: { fixture: string; width: number; height: number; displayName?: string },
): Promise<{ pieceId: string; fileId: string; overlayId: string; duration: number }> {
  const pRes = await request.post("/api/pieces");
  expect(pRes.ok()).toBe(true);
  const pieceId = ((await pRes.json()) as { id: string }).id;

  const dimRes = await request.patch(`/api/pieces/${pieceId}/composition/dimensions`, {
    data: { width: opts.width, height: opts.height },
  });
  expect(dimRes.ok(), `dimensions → HTTP ${dimRes.status()}`).toBe(true);

  const file = fixturePath(opts.fixture);
  const duration = probeDurationSeconds(file);
  const name = path.basename(file);
  const upRes = await request.post(`/api/pieces/${pieceId}/upload`, {
    multipart: {
      file: { name, mimeType: "video/mp4", buffer: fs.readFileSync(file) },
      mediaDuration: String(duration),
    },
  });
  expect(upRes.ok(), `upload → HTTP ${upRes.status()}`).toBe(true);
  const fileId = ((await upRes.json()) as { file: { id: string } }).file.id;

  const added = await runTool(request, "libi.add_overlay", {
    pieceId,
    kind: "video",
    fileId,
    displayName: opts.displayName ?? "base",
    startTime: 0,
    duration,
  });
  return { pieceId, fileId, overlayId: String(added.data?.overlayId ?? ""), duration };
}

/**
 * Upload a fixture file via the resources panel's file input.
 * Requires `data-testid="resources-upload-input"` on the file input.
 */
export async function uploadFile(page: Page, fixtureName: string): Promise<void> {
  const input = page.locator("[data-testid=\"resources-upload-input\"]");
  await input.setInputFiles(fixturePath(fixtureName));
  await expect(
    page.locator(`[data-testid="asset-row"]:has-text("${fixtureName}")`),
  ).toBeVisible({ timeout: 15_000 });
}

/**
 * The headers libi's own page sends on a same-origin write. Routes whose action
 * only the user takes from the page (a publish confirm, the creator key's reveal
 * and import, the nickname, a template's visibility) refuse any request without
 * them (`browserOnlyRefusal`, lib/security/request-guard.ts); a spec that sets
 * such state up through the API poses as the page.
 */
export function asThePage(): Record<string, string> {
  return { origin: `http://127.0.0.1:${process.env.LIBI_E2E_PORT}`, "sec-fetch-site": "same-origin" };
}
