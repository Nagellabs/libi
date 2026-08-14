/**
 * Preview warming-eval harness — drives the live editor (Playwright + Chromium
 * over the running dev server) to MEASURE playback smoothness across seek
 * positions. The regression gate for the warming engine
 * (`lib/preview/warming.ts`); see docs-local/superpowers/plans/2026-05-31-preview-warming-engine.md.
 *
 * Each position opens a FRESH page (faithful to "open editor, seek, play") so
 * probes don't contaminate each other's <video> state. Prints a SMOOTH/STALL
 * verdict per position (SMOOTH = no `buffering` phase AND no >2-sample frame
 * stall, ignoring the timeline loop-wrap).
 *
 * Usage:
 *   npm run preview:eval                       # AV Sync Test, default spread
 *   npm run preview:eval -- --piece <id>       # another piece
 *   npm run preview:eval -- --positions 0,90,135,195   # explicit start frames
 *   npm run preview:eval -- --base http://localhost:3463
 */
import { chromium } from "playwright";

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

const BASE = arg("base", "http://localhost:3463");
const PIECE = arg("piece", "cde97a87-c9d6-462b-98dd-a494ab578442"); // AV Sync Test
const FPS = Number(arg("fps", "30"));
const POSITIONS_RAW = arg("positions", "");
const POSITIONS = POSITIONS_RAW
  ? POSITIONS_RAW.split(",")
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isFinite(n))
  : [];

async function freshPage(browser) {
  const page = await browser.newPage();
  await page.addInitScript((pieceId) => {
    window.localStorage.setItem("libi:preview-probe", "1");
    try {
      window.localStorage.setItem(
        "libi:editor-state",
        JSON.stringify({ lastPieceId: pieceId, lastEditorTab: "timeline" }),
      );
    } catch {}
  }, PIECE);
  await page.goto(`${BASE}/editor`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(
    () => window.__libiPreviewProbe && window.__libiPreviewProbe.frame >= 0,
    null,
    { timeout: 20000 },
  );
  await page
    .waitForFunction(() => document.querySelectorAll("video").length >= 2, null, {
      timeout: 20000,
    })
    .catch(() => {});
  await page.waitForTimeout(2500); // let sources construct + buffer
  return page;
}

async function probe(browser, label, startFrame, ms) {
  const page = await freshPage(browser);
  await page.evaluate((f) => window.__libiPreviewProbe.seek(f), startFrame);
  await page.waitForTimeout(350);
  await page.evaluate(() => window.__libiPreviewProbe.play());
  const samples = [];
  const start = Date.now();
  while (Date.now() - start < ms) {
    samples.push(
      await page.evaluate(() => ({
        f: window.__libiPreviewProbe.frame,
        ph: window.__libiPreviewProbe.phase,
      })),
    );
    await page.waitForTimeout(100);
  }
  await page.close();

  // Truncate at the timeline loop (frame decrease) so the wrap-to-0 isn't
  // miscounted as a stall — we only care about the seam-exit hand-off.
  let fr = samples.map((s) => s.f);
  let ph = samples.map((s) => s.ph);
  for (let i = 1; i < fr.length; i++) {
    if (fr[i] < fr[i - 1] - 1) {
      fr = fr.slice(0, i);
      ph = ph.slice(0, i);
      break;
    }
  }
  const advanced = fr[fr.length - 1] - fr[0];
  const buffered = ph.some((p) => p === "buffering");
  let maxStall = 0;
  let cur = 0;
  for (let i = 1; i < fr.length; i++) {
    if (fr[i] === fr[i - 1]) cur++;
    else cur = 0;
    maxStall = Math.max(maxStall, cur);
  }
  const smooth = !buffered && maxStall <= 2;
  console.log(
    `${smooth ? "✅ SMOOTH" : "❌ STALL "}  ${label} (f=${startFrame}/${(startFrame / FPS).toFixed(2)}s): ` +
      `advanced ${advanced} buffered=${buffered} maxStall=${maxStall}(~${maxStall * 100}ms)`,
  );
  return smooth;
}

async function run() {
  await fetch(`${BASE}/api/editor/open-piece`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ pieceId: PIECE }),
  }).catch(() => {});

  const browser = await chromium.launch({
    headless: true,
    args: ["--autoplay-policy=no-user-gesture-required"],
  });

  // Default spread for a 2-video / 8s piece (cut at 4.0s=f120, seam ~[2.5,5.5]).
  const defaults = [
    ["from start", 0, 7000],
    ["before window", 45, 6000],
    ["in-window pre-cut", 90, 4000],
    ["in-window post-cut", 135, 4000],
    ["near exit", 156, 4000],
    ["after window", 195, 3000],
  ];
  const runs = POSITIONS.length
    ? POSITIONS.map((f) => [`seek f${f}`, f, 4000])
    : defaults;

  let allSmooth = true;
  for (const [label, f, ms] of runs) {
    const ok = await probe(browser, label, f, ms);
    allSmooth = allSmooth && ok;
  }
  await browser.close();
  console.log(allSmooth ? "\nALL SMOOTH" : "\nSOME STALLED (see above)");
}

run().catch((e) => {
  console.error("EVAL ERROR:", e);
  process.exit(1);
});
