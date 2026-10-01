import fs from "fs";
import { execFileSync, spawnSync } from "child_process";
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

/** Loudest sample in dB; -Infinity when the file has no audio stream at all. */
function maxVolumeDb(filePath: string): number {
  const streams = execFileSync("ffprobe", ["-v", "error", "-select_streams", "a", "-show_entries", "stream=index", "-of", "csv=p=0", filePath], { encoding: "utf8" }).trim();
  if (!streams) return -Infinity;
  const out = spawnSync("ffmpeg", ["-hide_banner", "-nostats", "-i", filePath, "-af", "volumedetect", "-f", "null", "-"], { encoding: "utf8" });
  const m = /max_volume:\s*(-?[\d.]+|-inf) dB/.exec(out.stderr);
  return !m || m[1] === "-inf" ? -Infinity : Number(m[1]);
}

async function exportResultPath(request: APIRequestContext, jobId?: string): Promise<string> {
  if (jobId) {
    for (let i = 0; i < 240; i++) {
      const j = (await (await request.get(`/api/jobs/${jobId}`)).json()) as { status: string; resultJson: string | null };
      if (j.status === "completed") return (JSON.parse(j.resultJson ?? "{}") as { filePath: string }).filePath;
      if (j.status === "failed") throw new Error(`export ${jobId} failed`);
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error(`export ${jobId} did not finish`);
  }
  const { jobs } = (await (await request.get("/api/jobs?kind=export&status=completed&limit=1")).json()) as { jobs: Array<{ resultJson: string | null }> };
  return (JSON.parse(jobs[0].resultJson ?? "{}") as { filePath: string }).filePath;
}

/**
 * A piece whose EXPORT will actually fit Instagram Reel / TikTok's 9:16
 * requirement. `POST /api/pieces` already defaults a new piece to the user's
 * aspect-ratio setting, itself defaulting to 9:16 / 1080×1920
 * (`lib/composition/aspect-ratio.ts#DEFAULT_ASPECT_RATIO_ID`, applied by
 * `lib/composition/new-piece-manifest.ts#initializePieceManifest`) — but
 * regardless of whatever that setting is, the exported frame is the
 * COMPOSITION's size, not `tiny.mp4`'s own 320×240, so the dimensions are set
 * explicitly here rather than relied on, via the same route the empty-piece
 * UI uses (`PATCH /api/pieces/:id/composition/dimensions`). The video overlay
 * is then added with no `rect`, which defaults to the full new frame.
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
 * trigger. Export then queues the render and returns straight to the Posting
 * tab, which says the export is rendering and selects it once it finishes
 * (`export-dialog.tsx`'s `returnToPost`, `media-step.tsx`).
 */
async function exportViaPostingTab(page: Page): Promise<void> {
  await page.getByRole("tab", { name: "Posting" }).click();
  const tab = page.getByTestId("posting-tab");
  await expect(tab).toBeVisible();
  await tab.getByRole("button", { name: "Export & post" }).click();

  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible({ timeout: 15_000 });
  // Every export shows what it's for (Social preselected) and every track;
  // tiny.mp4 was uploaded, so its sound is the user's own and on
  // (components/export/export-audio-section.tsx).
  await expect(dialog.getByTestId("export-purpose-social")).toHaveAttribute("aria-checked", "true");
  await expect(dialog.getByTestId("export-audio-list")).toBeVisible();
  await dialog.getByRole("button", { name: "Export", exact: true }).click();
  await expectExportAdoptedByComposer(page);
}

/** After Start from the composer: back on Posting at once, then the finished export is selected. */
async function expectExportAdoptedByComposer(page: Page): Promise<void> {
  const tab = page.getByTestId("posting-tab");
  await expect(tab).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("dialog")).toBeHidden();
  await expect(tab.getByTestId("export-line")).toBeVisible({ timeout: 120_000 });
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

    // Music step: tiny.mp4's sound is the user's own — the card just says so.
    await expect(posting.getByTestId("music-step")).toBeVisible();
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

    // Music step: tiny.mp4's sound is the user's own — the card just says so.
    await expect(tab.getByTestId("music-step")).toBeVisible();
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

  test("a named song: matched on TikTok when added, shown in the Music step, and left out of a Social export", async ({ page }) => {
    const request = page.request;
    const pieceId = await seedPortraitPiece(request);
    const up = await request.post(`/api/pieces/${pieceId}/upload`, {
      multipart: { file: { name: "espresso.m4a", mimeType: "audio/mp4", buffer: fs.readFileSync(fixturePath("video/tone-5s.m4a")) }, mediaDuration: "5" },
    });
    expect(up.ok()).toBe(true);
    const listed = await (await request.get(`/api/pieces/${pieceId}/files`)).json();
    const all = (Array.isArray(listed) ? listed : listed.files) as Array<{ id: string; filename: string }>;
    const songId = all.find((f) => f.filename === "espresso.m4a")!.id;
    const videoId = all.find((f) => f.filename === "tiny.mp4")!.id;

    // The agent's path: rights ride on the add, and the song is matched in the same call.
    const add = await request.post("/api/e2e/run-tool", {
      data: { tool: "libi.audio_add_clip", args: { pieceId, fileId: songId, kind: "standalone", startTime: 0, lengthPolicy: "trim", rights: { class: "copyrighted", track: { title: "Espresso", artist: "Sabrina Carpenter" } } } },
    });
    expect(add.ok()).toBe(true);
    const added = JSON.stringify(await add.json());
    expect(added).toContain('"status":"picked"'); // TikTok's trending list has it (Business lane)
    expect(added).toContain("needs_facebook_login"); // Instagram can't attach on Instagram Login

    await openPiece(page, pieceId);
    await page.getByRole("tab", { name: "Posting" }).click();
    const tab = page.getByTestId("posting-tab");
    await tab.getByRole("button", { name: "Export & post" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible({ timeout: 15_000 });
    await expect(dialog.getByTestId("export-video-column")).toBeVisible();
    await expect(dialog.getByTestId("export-audio-column")).toBeVisible();
    await expect(dialog.getByTestId("export-purpose-social")).toHaveAttribute("aria-checked", "true");
    await expect(dialog.getByTestId(`export-audio-include-${songId}`)).not.toBeChecked();
    await expect(dialog.getByTestId(`export-audio-platforms-${songId}`)).toContainText("TikTok attaches it at posting");
    // Leave the video's own (non-copyrighted) sound out too: excludeFileIds.
    await dialog.getByTestId(`export-audio-include-${videoId}`).click();
    await expect(dialog.getByTestId("export-summary")).toContainText("0 of 2 audio tracks");
    const enqueued = page.waitForResponse(
      (resp) => new URL(resp.url()).pathname === "/api/export" && resp.request().method() === "POST",
    );
    await dialog.getByRole("button", { name: "Export", exact: true }).click();
    const socialJobId = ((await (await enqueued).json()) as { jobId: string }).jobId;
    await expectExportAdoptedByComposer(page);
    // Nothing plays in the Social export: the song by default, the video's sound by its switch.
    expect(maxVolumeDb(await exportResultPath(request, socialJobId))).toBeLessThanOrEqual(-60);

    // Personal, video sound left out: the song is what you hear.
    const personal = await request.post("/api/export", { data: { pieceId, purpose: "personal", excludeFileIds: [videoId] } });
    expect(personal.ok()).toBe(true);
    expect(maxVolumeDb(await exportResultPath(request, (await personal.json()).jobId))).toBeGreaterThan(-40);

    // Still on Posting (the dialog returned there): the Music step shows TikTok's matched track and Instagram's reconnect.
    await expect(tab).toBeVisible({ timeout: 15_000 });
    await tab.getByTestId("composer-next").click(); // media -> targets
    await expect(tab.getByTestId("targets-step")).toBeVisible();
    await tab.getByTestId("tiktok-consent-preview").click();
    await tab.getByTestId("tiktok-consent-express").click();
    await expect(tab.getByTestId("composer-next")).toBeEnabled();
    await tab.getByTestId("composer-next").click(); // targets -> music
    await expect(tab.getByTestId("music-step")).toBeVisible();
    const tiktokCard = tab.getByTestId(/^music-card-/).filter({ hasText: "TikTok" });
    await expect(tiktokCard.getByTestId("track-picker-selected")).toContainText("Espresso", { timeout: 15_000 });
    await expect(tiktokCard.getByTestId("track-picker-note")).toContainText("top 100 trending tracks");
    await expect(tab.getByTestId(/^music-card-/).filter({ hasText: "Instagram" })).toContainText("Facebook Login");

    // What the Music step decided for TikTok is what goes on the wire
    // (0.1.17 verification F1: the TikTok options were rebuilt without it).
    await tab.getByTestId("composer-next").click(); // music -> caption
    await expect(tab.getByTestId("caption-step")).toBeVisible();
    await tab.getByTestId("caption-input").fill("Espresso on the desk");
    await tab.getByTestId("composer-next").click(); // caption -> when
    await expect(tab.getByTestId("when-draft")).toBeChecked();
    await tab.getByTestId("composer-next").click(); // when -> review
    const created = page.waitForRequest(
      (r) => new URL(r.url()).pathname === "/api/social/posts" && r.method() === "POST",
    );
    await tab.getByTestId("composer-submit").click();
    const sent = (await created).postDataJSON() as {
      targets: Array<{ options: { platform: string; music?: { mode: string; track?: { title?: string } } } }>;
    };
    const tiktokMusic = sent.targets.find((t) => t.options.platform === "tiktok")?.options.music;
    expect(tiktokMusic?.mode).toBe("attach");
    expect(tiktokMusic?.track?.title).toContain("Espresso");
  });
});
