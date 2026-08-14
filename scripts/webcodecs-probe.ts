// scripts/webcodecs-probe.ts
import { chromium } from "playwright-core";
import { writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HTML = `<!doctype html>
<html><body><script>
  (async () => {
    const configs = [
      { label: "h264-baseline", codec: "avc1.42001E" },
      { label: "h264-high",     codec: "avc1.640033" },
      { label: "vp9",           codec: "vp09.00.10.08" },
      { label: "av1",           codec: "av01.0.04M.08" },
    ];
    const results = [];
    for (const c of configs) {
      try {
        const r = await VideoEncoder.isConfigSupported({
          codec: c.codec, width: 1920, height: 1080, bitrate: 5_000_000, framerate: 30,
        });
        results.push({ ...c, supported: r.supported === true });
      } catch (err) {
        results.push({ ...c, supported: false, error: String(err) });
      }
    }
    document.title = "DONE:" + JSON.stringify(results);
  })();
</script></body></html>`;

async function main() {
  // WebCodecs requires a secure context. file:// URLs are treated as secure contexts
  // in Chromium (unlike about:blank or data: URLs which have null origin). We also
  // explicitly use `channel: "chromium"` to force the full Chromium build rather than
  // `chrome-headless-shell`, which ships without WebCodecs.
  const htmlPath = join(tmpdir(), `webcodecs-probe-${Date.now()}.html`);
  writeFileSync(htmlPath, HTML, "utf8");

  const browser = await chromium.launch({
    headless: true,
    channel: "chromium",
    args: [
      "--enable-features=OpenH264SoftwareEncoder",
      "--use-gl=swiftshader",
    ],
  });
  try {
    const page = await browser.newPage();
    await page.goto("file://" + htmlPath);
    await page.waitForFunction(() => document.title.startsWith("DONE:"), null, { timeout: 10_000 });
    const title = await page.title();
    const json = title.replace(/^DONE:/, "");
    console.log(JSON.stringify({
      platform: process.platform,
      arch: process.arch,
      results: JSON.parse(json),
    }, null, 2));
  } finally {
    await browser.close();
    try { unlinkSync(htmlPath); } catch {}
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
