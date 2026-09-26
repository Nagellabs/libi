import fs from "fs";
import { execFileSync } from "child_process";
import type { APIRequestContext, Page } from "@playwright/test";
import { test, expect, answerPersona, fixturePath } from "./helpers/app";

/**
 * Social posting (fake Zernio), run against the strict fake from Task 13 —
 * see `.superpowers/sdd/task-21-brief.md` and `.superpowers/sdd/zernio-live-shapes.md`.
 *
 * Tests run in declaration order (the config is `workers: 1` /
 * `fullyParallel: false`) and share ONE spawned libi + scratch DB for the
 * whole file, so later tests rely on state earlier ones left behind:
 *   1. picks Zernio as the provider — every later test needs that setting.
 *   2. the Instagram-only compose journey (draft → schedule → cancel → publish).
 *   3. the TikTok-only compose journey, which the config's `failTarget`
 *      scenario (playwright.config.ts) makes fail on publish, then retries it.
 *   4. the Ads tab, read-only against the two accounts' real (live-verified)
 *      "no ads tree" answers.
 *
 * Both fixture accounts are named "nagellabs" (`mcp/dev/fake-zernio/state.ts`),
 * so tests disambiguate by platform label rather than by account id.
 */

function probeDurationSeconds(filePath: string): number {
  return Number(
    execFileSync(
      "ffprobe",
      ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", filePath],
      { encoding: "utf8" },
    ).trim(),
  );
}

/**
 * A piece whose EXPORT will actually fit Instagram Reel / TikTok's 9:16
 * requirement. The composition defaults to 1920×1080 landscape
 * (`lib/composition/build-composition.ts`) regardless of the source clip's
 * own resolution — the exported frame is the composition's size, not
 * `tiny.mp4`'s 320×240 — so the dimensions are set explicitly, on an
 * overlay-free piece, via the same route the empty-piece UI uses
 * (`PATCH /api/pieces/:id/composition/dimensions`). The video overlay is
 * then added with no `rect`, which defaults to the full new frame.
 */
async function seedPortraitPiece(request: APIRequestContext): Promise<string> {
  const pRes = await request.post("/api/pieces");
  expect(pRes.ok()).toBe(true);
  const pieceId = (await pRes.json()).id as string;

  const dimRes = await request.patch(`/api/pieces/${pieceId}/composition/dimensions`, {
    data: { width: 1080, height: 1920 },
  });
  expect(dimRes.ok()).toBe(true);

  const fixture = fixturePath("tiny.mp4");
  const duration = probeDurationSeconds(fixture);
  const buf = fs.readFileSync(fixture);
  const uploadRes = await request.post(`/api/pieces/${pieceId}/upload`, {
    multipart: {
      file: { name: "tiny.mp4", mimeType: "video/mp4", buffer: buf },
      mediaDuration: String(duration),
    },
  });
  expect(uploadRes.ok()).toBe(true);

  const filesRes = await request.get(`/api/pieces/${pieceId}/files`);
  const filesBody = await filesRes.json();
  const arr = Array.isArray(filesBody) ? filesBody : (filesBody.files ?? []);
  const fileId = arr.find((f: { filename: string }) => f.filename === "tiny.mp4")?.id;
  if (!fileId) throw new Error("tiny.mp4 not present on seeded piece");

  // `startTime`/`duration` are required by add_overlay's schema, which
  // /api/e2e/run-tool now enforces as the MCP endpoint does. Before it did,
  // omitting them persisted `undefined`, which crashed the Timeline's
  // `OverlayBar` the moment a browser rendered it (`bar.startTime.toFixed is
  // not a function`) — found running this spec.
  const overlayRes = await request.post("/api/e2e/run-tool", {
    data: { tool: "libi.add_overlay", args: { pieceId, kind: "video", fileId, displayName: "post-clip", startTime: 0, duration } },
  });
  expect(overlayRes.ok()).toBe(true);

  return pieceId;
}

/**
 * Open a specific piece in the editor. `activePieceId` is client-local state
 * restored from `localStorage` (`lib/editor-state-context.tsx`), not a URL
 * param — `addInitScript` seeds it before the app's first script runs, the
 * same restore path a returning user's browser would take.
 */
async function openPiece(page: Page, pieceId: string): Promise<void> {
  await answerPersona(page.request);
  await page.addInitScript(
    ({ pieceId }) => {
      window.localStorage.setItem("libi:editor-state", JSON.stringify({ lastPieceId: pieceId, lastEditorTab: "preview" }));
    },
    { pieceId },
  );
  await page.goto("/editor");
  await expect(page.getByTestId("editor-panel")).toBeVisible({ timeout: 30_000 });
}

/**
 * From an open piece with no export yet: the Posting tab's "Export & post"
 * (`components/social/composer/media-step.tsx`) requests the REAL export
 * dialog, which lives inside the Timeline tab and opens itself in response
 * (`hooks/social/use-posting-intent.ts#useExportDialogRequest`) — so once
 * requested, the dialog is found already open rather than via its own
 * trigger. "Post…" on the success card then hands the export straight back
 * to the Posting tab (`export-dialog.tsx`'s `onPost`).
 */
async function exportViaPostingTab(page: Page): Promise<void> {
  await page.getByRole("tab", { name: "Posting" }).click();
  const tab = page.getByTestId("posting-tab");
  await expect(tab).toBeVisible();
  await tab.getByRole("button", { name: "Export & post" }).click();

  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible({ timeout: 15_000 });
  await dialog.getByRole("button", { name: "Export", exact: true }).click();
  await expect(page.getByTestId("export-post-button")).toBeVisible({ timeout: 120_000 });
  await page.getByTestId("export-post-button").click();
  await expect(page.getByTestId("posting-tab")).toBeVisible({ timeout: 15_000 });
}

test.describe("Social posting (fake Zernio)", () => {
  test("provider picker → Settings shows both connections and both accounts", async ({ page }) => {
    await answerPersona(page.request);
    await page.goto("/social");

    await expect(page.getByText("Pick a provider")).toBeVisible({ timeout: 30_000 });
    await page.getByRole("radio", { name: /Zernio/ }).check();
    await page.getByRole("button", { name: "Continue" }).click();

    // Settings: libi's own connection to the fake reads as connected
    // immediately in test mode (`lib/social/test-fake.ts#ensureTestModeGrant`),
    // separate from — and regardless of — the agent's own Zernio sign-in.
    await page.getByRole("tab", { name: /settings/i }).click();
    await expect(page.getByTestId("libi-connection-section")).toContainText(/Connected as Zernio/, { timeout: 15_000 });
    await expect(page.getByTestId("agent-connection-row-claude-code")).toBeVisible();
    await expect(page.getByTestId("agent-connection-row-codex")).toBeVisible();

    // Both fixture accounts (`mcp/dev/fake-zernio/state.ts`) show up on the
    // same tab — the Dashboard that used to hold them is gone — sharing the
    // same @nagellabs username across platforms.
    await expect(page.getByTestId("accounts-strip")).toBeVisible();
    await expect(page.getByText("@nagellabs")).toHaveCount(2);
  });

  test("piece with no export → \"Export & post\"; export → media/targets/caption/when/review → draft → schedule → cancel → publish", async ({
    page,
    request,
  }) => {
    const pieceId = await seedPortraitPiece(request);
    await openPiece(page, pieceId);

    // No export yet: the composer's Media step is the "Export & post" hand-off.
    await page.getByRole("tab", { name: "Posting" }).click();
    await expect(page.getByTestId("posting-tab").getByRole("button", { name: "Export & post" })).toBeVisible();
    await exportViaPostingTab(page);

    const posting = page.getByTestId("posting-tab");
    await expect(posting.getByText(/fits Instagram Reel/)).toBeVisible({ timeout: 15_000 });
    await expect(posting.getByText(/fits TikTok video/)).toBeVisible();
    await posting.getByTestId("composer-next").click();

    // Targets step: both accounts start selected (every connected account
    // seeds as a target) — drop TikTok so this journey's publish succeeds
    // cleanly; the TikTok-only journey (and its required consents/options)
    // is exercised in the next test.
    await expect(posting.getByTestId("targets-step")).toBeVisible();
    await posting.getByRole("checkbox", { name: /TikTok/ }).uncheck();
    await expect(posting.getByTestId("composer-next")).toBeEnabled();
    await posting.getByTestId("composer-next").click();

    // Caption step.
    await expect(posting.getByTestId("caption-step")).toBeVisible();
    await posting.getByTestId("caption-input").fill("The desk setup that finally works");
    await posting.getByTestId("composer-next").click();

    // When step: draft is the default.
    await expect(posting.getByTestId("when-step")).toBeVisible();
    await expect(posting.getByTestId("when-draft")).toBeChecked();
    await posting.getByTestId("composer-next").click();

    // Review → Save draft.
    await expect(posting.getByTestId("review-step")).toBeVisible();
    await expect(posting.getByTestId("composer-submit")).toHaveText("Save draft");
    await posting.getByTestId("composer-submit").click();

    // The draft appears in the piece's own post list…
    const list = posting.getByTestId("piece-posts-list");
    const row = list.getByTestId("post-row").first();
    await expect(row).toBeVisible({ timeout: 15_000 });
    await expect(row.getByTestId("status-chip")).toHaveAttribute("data-status", "draft");
    await expect(row.getByText(/\d{2}:\d{2}/)).toHaveCount(0); // a draft shows no time

    // …and on the Social page, without a reload.
    await page.goto("/social?tab=posts");
    await expect(page.getByTestId("post-row").first()).toContainText("The desk setup that finally works");

    // Back to the piece to drive the rest of the lifecycle from its own row.
    await openPiece(page, pieceId);
    await page.getByRole("tab", { name: "Posting" }).click();
    const list2 = page.getByTestId("piece-posts-list");
    const row2 = list2.getByTestId("post-row").first();

    // Schedule.
    await row2.getByTestId("post-action-schedule").click();
    const schedulePopover = page.locator('[data-slot="popover-content"]');
    // The quick picks ARE the common path — almost every real schedule is
    // "tomorrow morning" rather than a date walked out on a calendar. The
    // readback is asserted because a schedule silently landing on the wrong
    // day is the failure this picker exists to prevent.
    await expect(schedulePopover.getByTestId("reschedule-readback")).toContainText("No time chosen yet");
    await schedulePopover.getByTestId("reschedule-pick-tomorrow").click();
    await expect(schedulePopover.getByTestId("reschedule-readback")).toContainText(/\d{2}:\d{2}/);
    await schedulePopover.locator('input[type="text"]').fill("UTC");
    await schedulePopover.getByRole("button", { name: "Save" }).click();
    await expect(row2.getByTestId("status-chip")).toHaveAttribute("data-status", "scheduled", { timeout: 10_000 });

    // Cancel — back to draft, and the old `scheduledFor` must never render as
    // a schedule again (`.superpowers/sdd/zernio-live-shapes.md`).
    await row2.getByTestId("post-action-cancel").click();
    await expect(row2.getByTestId("status-chip")).toHaveAttribute("data-status", "draft", { timeout: 10_000 });
    await expect(row2.getByText(/\d{2}:\d{2}/)).toHaveCount(0);

    // Publish now — one target (Instagram), no undo.
    await row2.getByTestId("post-action-publish").click();
    const publishConfirm = page.getByRole("alertdialog");
    await expect(publishConfirm).toBeVisible();
    await expect(publishConfirm).toContainText(/no undo/i);
    await publishConfirm.getByRole("button", { name: "Publish now", exact: true }).click();
    await expect(row2.getByTestId("status-chip")).toHaveAttribute("data-status", "published", { timeout: 15_000 });
    await expect(row2.getByTestId("target-chip")).toHaveCount(1);
    await expect(row2.getByTestId("target-chip")).toHaveAttribute("data-status", "published");
  });

  test("TikTok-only compose: real creator-info options, a publish that fails, and a verbatim retry", async ({ page, request }) => {
    const pieceId = await seedPortraitPiece(request);
    await openPiece(page, pieceId);
    await exportViaPostingTab(page);

    const tab = page.getByTestId("posting-tab");
    await expect(tab.getByTestId("media-step")).toBeVisible({ timeout: 15_000 });
    await tab.getByTestId("composer-next").click();

    await expect(tab.getByTestId("targets-step")).toBeVisible();
    await tab.getByRole("checkbox", { name: /Instagram/ }).uncheck();
    await expect(tab.getByTestId(`target-tiktok`)).toBeVisible();

    // Rendered from THIS account's own creator info
    // (`accounts_get_tik_tok_creator_info`), never a hardcoded list.
    await expect(tab.getByRole("radio", { name: "Public" })).toBeChecked();
    // All three interactions start ON because the account is ALLOWED them
    // (`enabled`), not because TikTok suggests them — it reports
    // `default: false` for all three, and a post that ships with comments,
    // duets and stitches off cannot travel. `required` means the field must be
    // SENT, which is why it is no longer shown to the user at all.
    for (const id of ["tiktok-allow_comment", "tiktok-allow_duet", "tiktok-allow_stitch"]) {
      await expect(tab.getByTestId(id)).toHaveAttribute("aria-checked", "true");
    }
    await expect(tab.getByText("(required by TikTok)")).toHaveCount(0);
    // Live: this account offers exactly ONE privacy level
    // (`.superpowers/sdd/zernio-live-shapes.md`) — a fake that offered a second by
    // default would hide that, so this now asserts the real shape rather than only
    // the one level's presence.
    await expect(tab.getByRole("radio")).toHaveCount(1);

    // The two consent checkboxes are the only things this step actually
    // gates on — required to leave Targets at all.
    await expect(tab.getByTestId("composer-next")).toBeDisabled();
    await tab.getByTestId("tiktok-consent-preview").check();
    await tab.getByTestId("tiktok-consent-express").check();
    await expect(tab.getByTestId("composer-next")).toBeEnabled();
    await tab.getByTestId("composer-next").click();

    await expect(tab.getByTestId("caption-step")).toBeVisible();
    await tab.getByTestId("caption-input").fill("Retry me");
    await tab.getByTestId("composer-next").click();

    await expect(tab.getByTestId("when-step")).toBeVisible();
    await tab.getByTestId("when-now").check();
    await tab.getByTestId("composer-next").click();

    await expect(tab.getByTestId("review-step")).toBeVisible();
    await tab.getByTestId("composer-submit").click(); // opens the "Publish now?" confirm
    const confirm = page.getByRole("alertdialog");
    await expect(confirm).toBeVisible();
    await confirm.getByTestId("publish-now-confirm").click();

    // The scenario config (`playwright.config.ts`) makes every TikTok publish
    // fail with this exact message — read it back verbatim off the target chip.
    const list = page.getByTestId("piece-posts-list");
    const row = list.getByTestId("post-row").first();
    await expect(row).toBeVisible({ timeout: 15_000 });
    await expect(row.getByTestId("status-chip")).toHaveAttribute("data-status", "failed", { timeout: 15_000 });
    const chip = row.getByTestId("target-chip");
    await expect(chip).toHaveAttribute("data-status", "failed");
    await expect(chip).toHaveAttribute("title", "TikTok rejected this video: it failed automated content review.");

    // The composer's own detail sheet auto-opens over this same post after a
    // create (`posting-tab.tsx`'s `onDone`) — close it so its backdrop can't
    // intercept the click below.
    await page.keyboard.press("Escape");

    // Retry — the fake clears the scenario's failure on retry, so this succeeds.
    await row.getByTestId("post-action-retry").click();
    await expect(row.getByTestId("status-chip")).toHaveAttribute("data-status", "published", { timeout: 15_000 });
    await expect(row.getByTestId("target-chip")).toHaveAttribute("data-status", "published");
  });

  test("Ads tab: reporting only, no pause/resume, no budget inputs", async ({ page }) => {
    await answerPersona(page.request);
    await page.goto("/social?tab=ads");

    const unavailable = page.getByTestId("ads-unavailable");
    await expect(unavailable).toBeVisible({ timeout: 15_000 });
    // Both accounts' real (live-verified) "no ads tree" answers, verbatim —
    // Instagram has no linked Facebook account, TikTok has none at all here.
    await expect(unavailable).toContainText(/A connected Facebook account is required to manage Instagram ads/);
    await expect(unavailable).toContainText(/Ads are not available for this account/);

    await expect(page.getByRole("button", { name: "Pause", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Resume", exact: true })).toHaveCount(0);
    await expect(page.getByLabel(/budget/i)).toHaveCount(0);
    await expect(page.getByText(/every ad change, including pausing, goes through your agent/i)).toBeVisible();
    await expect(page.getByTestId("ask-agent-ads")).toBeVisible();
  });
});
