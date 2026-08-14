// Attach a CDP heap allocation sampler to the live Electron editor during
// playback, then aggregate allocated bytes by function/file to find the
// per-frame allocation source driving the recurring major GC.
//
// Usage: node scripts/dev/heap-sample-preview.mjs [cdpUrl] [playMs]
import { chromium } from "playwright-core";

const CDP_URL = process.argv[2] || "http://127.0.0.1:9222";
const PLAY_MS = Number(process.argv[3] || 12000);

function aggregate(profile) {
  // profile.head is a tree of {callFrame:{functionName,url,lineNumber}, selfSize, children}
  const bySelf = new Map(); // key -> {bytes, count}
  let total = 0;
  const walk = (node) => {
    const cf = node.callFrame || {};
    const self = node.selfSize || 0;
    if (self > 0) {
      const file = (cf.url || "").split("/").slice(-1)[0] || cf.url || "?";
      const key = `${cf.functionName || "(anon)"} @ ${file}:${cf.lineNumber ?? "?"}`;
      const prev = bySelf.get(key) || { bytes: 0, count: 0 };
      prev.bytes += self;
      prev.count += node.selfSize ? 1 : 0;
      bySelf.set(key, prev);
      total += self;
    }
    for (const c of node.children || []) walk(c);
  };
  walk(profile.head);
  const rows = [...bySelf.entries()]
    .map(([k, v]) => ({ k, bytes: v.bytes }))
    .sort((a, b) => b.bytes - a.bytes);
  return { rows, total };
}

(async () => {
  const browser = await chromium.connectOverCDP(CDP_URL);
  const contexts = browser.contexts();
  let page = null;
  for (const ctx of contexts) {
    for (const p of ctx.pages()) {
      const url = p.url();
      if (url.includes("/editor")) { page = p; break; }
    }
    if (page) break;
  }
  if (!page) {
    console.error("No /editor page found. Pages:", contexts.flatMap(c => c.pages().map(p => p.url())));
    await browser.close();
    process.exit(1);
  }
  console.log("Attached to:", page.url());

  const cdp = await page.context().newCDPSession(page);
  await cdp.send("HeapProfiler.enable");

  // Seek to 0 + ensure paused before sampling.
  await page.evaluate(() => { const P = window.__libiPreviewProbe; P.pause(); P.seek(0); });
  await new Promise(r => setTimeout(r, 400));

  // Sample at a fine interval so per-frame allocations are well-resolved.
  await cdp.send("HeapProfiler.startSampling", { samplingInterval: 4096 });
  await page.evaluate(() => window.__libiPreviewProbe.play());
  console.log(`Playing for ${PLAY_MS}ms while sampling...`);
  await new Promise(r => setTimeout(r, PLAY_MS));
  await page.evaluate(() => window.__libiPreviewProbe.pause());

  const { profile } = await cdp.send("HeapProfiler.stopSampling");
  const { rows, total } = aggregate(profile);
  console.log(`\n=== Total sampled allocation: ${(total / 1048576).toFixed(1)} MB over ${PLAY_MS}ms (${(total / 1048576 / (PLAY_MS / 1000)).toFixed(1)} MB/s) ===\n`);
  console.log("Top 30 self-allocation sites:");
  for (const r of rows.slice(0, 30)) {
    console.log(`  ${(r.bytes / 1024).toFixed(0).padStart(8)} KB  ${r.k}`);
  }

  await cdp.detach().catch(() => {});
  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
