import { _electron as electron, request, type ElectronApplication, type Page } from "@playwright/test";
import net from "node:net";
import path from "node:path";
import fs from "node:fs";
import { answerPersona } from "../helpers/app";

const ROOT = path.resolve(__dirname, "..", "..");
const MAIN = path.join(ROOT, "dist-electron", "electron", "main.js");

export interface LaunchedApp {
  app: ElectronApplication;
  main: Page;
}

export interface LaunchOptions {
  /**
   * Leave the first-launch persona question unanswered. A home that never
   * answered it is a first launch: `FirstLaunchGate` replaces `/editor` with the
   * Agents tab under the persona modal, so only a spec that tests that path
   * itself wants it.
   */
  firstLaunch?: boolean;
  /**
   * How long to wait for something to listen on LIBI_PORT before refusing.
   * Default 20 s: an attached dev studio that has only just booted may still be
   * binding its port.
   */
  studioWaitMs?: number;
}

/** Whether something accepts a TCP connection on 127.0.0.1:`port`. */
function listening(port: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port: Number(port) });
    const done = (v: boolean) => {
      socket.destroy();
      resolve(v);
    };
    socket.setTimeout(1_000, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

/**
 * Whether a studio is listening on `port`, retrying for up to `waitMs`. A TCP
 * connect, not an HTTP answer: a dev studio still compiling its first route
 * accepts the connection long before it answers, and that is a studio that is up.
 */
async function studioListening(port: string, waitMs: number): Promise<boolean> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    if (await listening(port)) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, 250));
  }
}

/**
 * Answer the persona question on the studio at `port`, through the product
 * route and posing as libi's own page, as the web specs' fixture does
 * (e2e/helpers/app.ts). Without it, a fresh home's first launch redirects
 * `/editor` to the Agents tab mid-spec: topbar.spec.ts measured the sidebar
 * while it was being replaced and got `null`.
 */
async function answerPersonaOn(port: string): Promise<void> {
  const origin = `http://127.0.0.1:${port}`;
  const ctx = await request.newContext({
    baseURL: origin,
    extraHTTPHeaders: { origin, "sec-fetch-site": "same-origin" },
  });
  try {
    await answerPersona(ctx);
  } finally {
    await ctx.dispose();
  }
}

/**
 * Launch the libi Electron app against the studio `npm run test:electron`
 * started (playwright.electron.config.ts), or the one LIBI_PORT names.
 * Resolves once the main (non-splash) window has finished loading.
 *
 * Refuses to launch when nothing listens on LIBI_PORT (after up to 20 s): the unpackaged shell
 * would wait 60 s and then put a modal "did not respond" dialog on the
 * owner's screen, once per test.
 *
 * The compiled main bundle MUST exist at `dist-electron/electron/main.js`
 * — `npm run test:electron` compiles it first.
 */
export async function launchLibi(opts: LaunchOptions = {}): Promise<LaunchedApp> {
  const port = process.env.LIBI_PORT ?? "3456";
  if (!(await studioListening(port, opts.studioWaitMs ?? 20_000))) {
    throw new Error(
      `no studio on :${port}; run through \`npm run test:electron\` (it starts one), ` +
        "or export the LIBI_PORT and LIBI_HOME of a studio that is running.",
    );
  }
  if (!opts.firstLaunch) await answerPersonaOn(port);
  if (!fs.existsSync(MAIN)) {
    throw new Error(
      `${MAIN} not found — run 'npm run compile:electron' first.`,
    );
  }
  const app = await electron.launch({
    args: [MAIN],
    env: {
      ...process.env,
      LIBI_PORT: port,
      // The test owns its own Playwright session via _electron.launch();
      // disable main.ts's --remote-debugging-port=9222 switch so we don't
      // collide with a developer-side `preview_start("Libi Electron")`
      // also running CDP on 9222. Playwright attaches via its own
      // debug port internally regardless.
      LIBI_CDP: "0",
      // No detached DevTools window: it would open on the owner's screen, and
      // with Playwright's CDP client it is the two-front-ends SIGTRAP.
      LIBI_NO_DEVTOOLS: process.env.LIBI_NO_DEVTOOLS ?? "1",
    },
    timeout: 60_000,
  });

  // Wait for the main window (skip splash if it shows up in production).
  const start = Date.now();
  while (Date.now() - start < 90_000) {
    const wins = app.windows();
    const found = wins.find((w) => {
      const url = w.url();
      return url.startsWith("http://127.0.0.1") || url.startsWith("http://localhost");
    });
    if (found) {
      try {
        await found.waitForLoadState("domcontentloaded", { timeout: 30_000 });
      } catch {
        // ignore — page may be partly hydrated
      }
      return { app, main: found };
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("Main window did not appear within 90s");
}
