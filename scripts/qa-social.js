#!/usr/bin/env node
/**
 * A throwaway libi with a piece that has done EVERYTHING on social, for
 * looking at the Posting tab and the Social page with real-shaped data
 * instead of whatever one account happens to hold.
 *
 *   node scripts/qa-social.js            # boot, seed, print the URL
 *   node scripts/qa-social.js --port 3470
 *
 * Nothing here touches the real provider or the developer's own LIBI_HOME:
 * it runs under `LIBI_TEST_MODE=1`, which swaps Zernio for the in-process fake
 * (`mcp/dev/fake-zernio/`), and under a scratch home it creates and reuses.
 *
 * Two boots, on purpose. The fixture stamps `metadata.libi.pieceId` on every
 * seeded post, and a piece's id is minted by the API — so the first boot
 * exists only to create the piece and learn its id, and the second serves the
 * fixture stamped with it. Skipping that would leave every seeded post an
 * orphan to "Re-index posts from provider", which is exactly the kind of
 * almost-right fixture that wastes an afternoon.
 */
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const argPort = process.argv.indexOf("--port");
const PORT = argPort > -1 ? Number(process.argv[argPort + 1]) : 3472;
const HOME = process.env.QA_SOCIAL_HOME ?? path.join(os.tmpdir(), "libi-qa-social");
const CONFIG = path.join(HOME, "fake-zernio-config.json");
const BASE = `http://127.0.0.1:${PORT}`;
const PIECE_NAME = "QA — social showcase";

/** Every post the fixture seeds, and how it relates to the piece. Kept in step
 *  with `mcp/dev/fake-zernio/qa-seed.ts` by name. */
const POST_IDS = [
  "qa_post_reel", "qa_post_feed", "qa_post_story", "qa_post_tiktok",
  "qa_post_facebook", "qa_post_x", "qa_post_youtube",
  "qa_post_scheduled", "qa_post_draft", "qa_post_partial",
];
/** The one ad that never was a post, so only libi's own link can place it. */
const DARK_AD_ID = "qa_ad_dark";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(pathname, init) {
  const res = await fetch(`${BASE}${pathname}`, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
  const text = await res.text();
  let body;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { raw: text };
  }
  if (!res.ok) throw new Error(`${init?.method ?? "GET"} ${pathname} -> ${res.status} ${text.slice(0, 300)}`);
  return body;
}

function boot() {
  const child = spawn(process.execPath, ["bin/libi.js", "--port", String(PORT)], {
    cwd: path.resolve(__dirname, ".."),
    env: {
      ...process.env,
      LIBI_TEST_MODE: "1",
      LIBI_HOME: HOME,
      LIBI_PORT: String(PORT),
      LIBI_FAKE_ZERNIO_CONFIG: CONFIG,
      LIBI_NO_DEVTOOLS: "1",
      // The fake is started in-process by `instrumentation.ts`; make sure a
      // stale URL from the caller's shell cannot point it somewhere else.
      LIBI_SOCIAL_MCP_URL: "",
    },
    stdio: ["ignore", "inherit", "inherit"],
  });
  return child;
}

async function waitForUp(timeoutMs = 120_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try {
      await api("/api/social/status");
      return;
    } catch {
      await sleep(1000);
    }
  }
  throw new Error(`libi did not answer on ${BASE} in time`);
}

async function stop(child) {
  child.kill("SIGTERM");
  await new Promise((r) => child.once("exit", r));
  // The port is not free the instant the parent exits.
  await sleep(2000);
}

(async () => {
  fs.mkdirSync(HOME, { recursive: true });

  // Phase 1 — no fixture, just enough of libi to mint a piece with a real
  // manifest behind it.
  fs.writeFileSync(CONFIG, JSON.stringify({}));
  let child = boot();
  await waitForUp();
  // A home that never answered the persona question is a first launch, and
  // `/editor` is routed to the Agents tab with the question over it — so the
  // QA piece would open on a page that is not the Posting tab.
  await api("/api/onboarding/persona", { method: "PUT", body: JSON.stringify({ persona: "developer" }) });
  // `GET /api/pieces` answers `{ pieces }`; `POST` answers the piece ITSELF,
  // not wrapped. Reusing an existing one keeps the URL stable across re-runs.
  const existing = (await api("/api/pieces")).pieces ?? [];
  const found = existing.find((p) => p.name === PIECE_NAME);
  const piece = found ?? (await api("/api/pieces", { method: "POST", body: JSON.stringify({ name: PIECE_NAME }) }));
  if (!piece?.id) throw new Error(`could not create the QA piece: ${JSON.stringify(piece).slice(0, 200)}`);
  console.log(`[qa-social] piece ${piece.id} (${found ? "reused" : "created"})`);
  await stop(child);

  // Phase 2 — the fixture, stamped with that piece.
  fs.writeFileSync(CONFIG, JSON.stringify(
      {
        seed: "qa",
        seedPieceId: piece.id,
        analyticsPendingCalls: 0,
        adsEnabled: true,
        // The seeded Story's own numbers. They come from Instagram's
        // story-insights endpoint, never from post analytics — which is why a
        // Story that reported nothing would look like the bug this fixture is
        // meant to show is fixed.
        storyInsights: {
          "17900000000000003": {
            source: "live",
            metrics: {
              views: 1840, reach: 1612, replies: 23, shares: 41, navigation: 1290,
              tapsForward: 980, tapsBack: 142, exits: 118, swipesForward: 50,
              profileVisits: 76, follows: 9, reposts: 4, totalInteractions: 153,
            },
          },
        },
      },
      null,
      2,
    ));
  child = boot();
  await waitForUp();

  // A fresh home has no provider chosen, and every social route refuses with
  // `no_provider` until one is — the test-mode grant says libi is connected,
  // not which provider it is connected TO.
  // The user's own settings take the browser-only checks, so this script — which
  // stands in for the user picking a provider — sends the page's headers.
  // BASE is http://127.0.0.1:<PORT>, so Origin equals the Host.
  await api("/api/social/settings", {
    method: "PUT",
    headers: { "sec-fetch-site": "same-origin", origin: BASE },
    body: JSON.stringify({
      providerId: "zernio",
      timezone: "Asia/Bangkok",
      defaults: { instagramType: "reel", aiLabel: true },
      pollSeconds: 30,
    }),
  });

  for (const providerPostId of POST_IDS) {
    await api("/api/social/links", {
      method: "POST",
      body: JSON.stringify({ pieceId: piece.id, providerPostId, createdBy: "ui" }),
    });
  }
  await api("/api/social/ad-links", {
    method: "POST",
    body: JSON.stringify({ pieceId: piece.id, providerAdId: DARK_AD_ID, platformAdId: "238000000000003", createdBy: "agent" }),
  });

  console.log(`\n[qa-social] ready — ${POST_IDS.length} posts, 3 ads (2 boosts + 1 ad-only)`);
  console.log(`[qa-social] Posting tab: ${BASE}/editor?piece=${piece.id}&tab=posting`);
  console.log(`[qa-social] Social page: ${BASE}/social`);
  console.log(`[qa-social] home: ${HOME}  ·  Ctrl-C to stop\n`);

  const bye = async () => {
    await stop(child);
    process.exit(0);
  };
  process.on("SIGINT", bye);
  process.on("SIGTERM", bye);
})().catch((err) => {
  console.error(`[qa-social] ${err.message}`);
  process.exit(1);
});
