import fs from "node:fs";
import path from "node:path";
import { isTestMode } from "@/lib/test-mode";
import { getLibiHome } from "@/lib/libi-home";
import { serverLogger as logger } from "@/lib/logger";
import { OAUTH_SCOPES } from "@/lib/social/catalog";
import { SocialTokenStore } from "@/lib/social/token-store";

/** The provider this fake stands in for — it IS fake-*zernio*. */
const FAKE_PROVIDER_ID = "zernio";

/**
 * Test mode's fake Zernio, attached to the studio process.
 *
 * ONE listener serves both surfaces: the in-app agent gets it in its ACP list
 * as `{ type: "http", name: "zernio", url }`, and libi's own social service
 * connects to the same URL (`service.ts#testModeUrl` reads
 * `LIBI_SOCIAL_MCP_URL`). That is the whole reason it is HTTP and not a stdio
 * child like fake-fal: a draft the agent creates must show up in the piece's
 * Posting tab, and two processes cannot share an in-memory store.
 *
 * `LIBI_SOCIAL_MCP_URL` already set means somebody else is providing the
 * server — a hand-run `mcp/dev/fake-zernio/index.ts`, or a scenario pointing
 * at something else — and nothing is started.
 */
let started: { url: string; close(): Promise<void> } | null = null;

export function fakeZernioUrl(): string | null {
  return started?.url ?? process.env.LIBI_SOCIAL_MCP_URL ?? null;
}

export async function startFakeZernioIfWanted(): Promise<void> {
  if (!isTestMode() || started) return;
  // An externally-supplied URL means the server is somebody else's; the grant
  // that lets libi's own connection reach it is still ours to write.
  if (!process.env.LIBI_SOCIAL_MCP_URL) {
    // Dynamic because `mcp/dev/**` is excluded from both shipped artifacts; a
    // static import would pull the fake into the production bundle graph.
    const { startFakeZernioHttp } = await import("@/mcp/dev/fake-zernio/http");
    const fake = await startFakeZernioHttp({ port: Number(process.env.LIBI_FAKE_ZERNIO_PORT ?? 0) });
    started = { url: fake.url, close: fake.close };
    process.env.LIBI_SOCIAL_MCP_URL = fake.url;
    const dir = path.join(getLibiHome(), "test-mode");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "zernio-url"), fake.url);
    // A standby session may have been built before this finished — its ACP list
    // would carry no zernio entry. Dropping the cache makes the next session
    // pick it up. Imported lazily: `lib/mcp-config.ts` reads `fakeZernioUrl()`
    // from this module, and a static import both ways is a cycle.
    const { invalidateMcpConfig } = await import("@/lib/mcp-config");
    invalidateMcpConfig({ reason: "fake-zernio-started" });
    logger.info({ tag: "social", op: "test_fake.started", url: fake.url }, "fake zernio attached for test mode");
  }
  // The one way to run test mode with the fake in front of the AGENT and libi
  // itself NOT connected — the state where the user's own Zernio sign-in works
  // and libi's does not, which the agent must handle without calling it broken.
  // It is an env flag rather than an absent `LIBI_SOCIAL_MCP_URL` because unset
  // is exactly what makes the block above start the fake and land here.
  if (process.env.LIBI_SOCIAL_TEST_NO_GRANT === "1") {
    logger.info(
      { tag: "social", op: "test_fake.grant_suppressed", providerId: FAKE_PROVIDER_ID },
      "LIBI_SOCIAL_TEST_NO_GRANT=1 — leaving libi's own connection unconnected",
    );
    return;
  }
  ensureTestModeGrant();
}

/**
 * The grant test mode connects under.
 *
 * The fake serves `/mcp` and nothing else — no authorization endpoint, no
 * token endpoint — so there is no sign-in for a user to complete against it,
 * and libi's own connection has to read as connected for the Social page, the
 * Posting tab and `libi.post_piece` to be exercisable at all. Writing a grant
 * is how that is said, because the alternative is what this replaced: the
 * service OR-ing test mode in beside the store, which answered
 * `connected: true` with no grant behind it — no `connectedAt`, no scopes, and
 * a `lastVerifiedAt` from a connection to the fake. One source of truth for
 * "connected", and it is a grant on disk.
 *
 * Two things keep it away from a real sign-in. It is never written over an
 * existing grant, and `testMode: true` makes the store ignore it whenever test
 * mode is off — so a leftover file can neither present the fake's bearer to
 * the real provider nor read as a connection the user has.
 */
function ensureTestModeGrant(): void {
  const store = new SocialTokenStore(FAKE_PROVIDER_ID);
  if (store.status().connected) return;
  store.write({
    // Not a credential: the same fixed string the service sends the fake as a
    // bearer (`service.ts#TEST_BEARER`). Nothing in test mode signs a request
    // from the grant — `connect()` uses the bearer directly.
    tokens: { access_token: "test-mode", token_type: "bearer", scope: OAUTH_SCOPES.join(" ") },
    client: null,
    connectedAt: new Date().toISOString(),
    scopes: [...OAUTH_SCOPES],
    testMode: true,
  });
  logger.info(
    { tag: "social", op: "test_fake.grant_written", providerId: FAKE_PROVIDER_ID },
    "test-mode grant written so libi's own connection to the fake reads as connected",
  );
}

/** Tests only: stop the listener and forget it. */
export async function __stopFakeZernioForTests(): Promise<void> {
  const held = started;
  started = null;
  delete process.env.LIBI_SOCIAL_MCP_URL;
  if (held) await held.close();
}
