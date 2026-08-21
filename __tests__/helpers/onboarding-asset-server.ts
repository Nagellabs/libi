/**
 * A real loopback HTTP server that serves the staged onboarding-v1 asset
 * fixtures, plus the two ways the network is allowed to betray us: bytes that
 * do not hash to what `assets.ts` pins, and a base that stops answering
 * part-way through the 21 downloads.
 *
 * Real sockets, real bytes. The onboarding build's whole value is that it
 * refuses a download it cannot verify, and a mocked `fetch` proves nothing
 * about that — the hash check lives below the fetch, in
 * `lib/net/fetch-and-store.ts`.
 *
 * Fixtures live in `docs-local/onboarding-v1/assets` and are GITIGNORED, so a
 * clone does not have them. Callers must gate on {@link haveOnboardingFixtures}
 * and skip LOUDLY — a green run that downloaded nothing is worse than a red one.
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import type { AddressInfo } from "node:net";

/** Where `npm run onboarding:extract` stages the published bytes. */
export const ONBOARDING_FIXTURE_DIR = path.join(
  process.cwd(),
  "docs-local/onboarding-v1/assets",
);

/** True when every slug in `ONBOARDING_ASSETS_V1` is present on disk. */
export function haveOnboardingFixtures(slugs: readonly string[]): boolean {
  return (
    fs.existsSync(ONBOARDING_FIXTURE_DIR) &&
    slugs.every((s) => fs.existsSync(path.join(ONBOARDING_FIXTURE_DIR, s)))
  );
}

/**
 * The message a skipped suite prints. Names the directory on purpose.
 *
 * Write it with `process.stderr.write`, NOT `console.warn`. Verified by
 * moving the fixture directory aside and running: vitest attaches intercepted
 * console output to the running task, so a top-level `console.warn` in a file
 * whose every task is skipped is swallowed entirely — the run then reports
 * "2 skipped" and nothing else, which is exactly the silent pass this message
 * exists to prevent.
 */
export function missingFixturesMessage(): string {
  return (
    `[onboarding] SKIPPED: asset fixtures missing at ${ONBOARDING_FIXTURE_DIR}. ` +
    `Run \`npm run onboarding:extract\` to stage the 21 published files, then re-run. ` +
    `These tests do NOT pass without them — a green run that downloaded nothing means nothing.`
  );
}

export interface OnboardingAssetServer {
  /** Value for LIBI_ONBOARDING_ASSET_BASE — NO `/v1` suffix; the resolver
   *  appends the version itself. */
  baseEnvValue: string;
  /** Serve `slug` with one byte flipped so its sha256 no longer matches. */
  serveCorruptedSlug(slug: string): void;
  /** Answer the first `n` asset requests normally, then 500 forever. */
  failAfterNFiles(n: number): void;
  /** How many asset bodies have been served successfully. */
  servedCount(): number;
  /** Clear corruption + failure injection and the served counter. */
  reset(): void;
  close(): Promise<void>;
}

/**
 * Start the fixture server on an ephemeral loopback port. Assets are served
 * under `/onboarding/<version>/<slug>`, mirroring the bucket layout.
 */
export async function startOnboardingAssetServer(): Promise<OnboardingAssetServer> {
  const corrupted = new Set<string>();
  let failAfter: number | null = null;
  let served = 0;

  const server = http.createServer((req, res) => {
    const slug = path.basename(new URL(req.url ?? "/", "http://x").pathname);
    const file = path.join(ONBOARDING_FIXTURE_DIR, slug);

    if (failAfter !== null && served >= failAfter) {
      res.writeHead(500, { "content-type": "text/plain" });
      res.end("injected failure");
      return;
    }
    if (!fs.existsSync(file)) {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("no such fixture");
      return;
    }

    const body = fs.readFileSync(file);
    if (corrupted.has(slug)) {
      // One flipped byte. Same length, same content-type, different sha256 —
      // exactly the silent-corruption case the pinned hash exists to catch.
      body[0] = body[0] ^ 0xff;
    }
    served += 1;
    res.writeHead(200, {
      "content-type": "application/octet-stream",
      "content-length": String(body.byteLength),
    });
    res.end(body);
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  return {
    baseEnvValue: `http://127.0.0.1:${port}/onboarding`,
    serveCorruptedSlug: (slug) => corrupted.add(slug),
    failAfterNFiles: (n) => {
      failAfter = n;
    },
    servedCount: () => served,
    reset: () => {
      corrupted.clear();
      failAfter = null;
      served = 0;
    },
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      ),
  };
}
