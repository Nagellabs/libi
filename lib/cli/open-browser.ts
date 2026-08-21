// lib/cli/open-browser.ts
//
// "Run the command, land in the app": `npx @nagellabs/libi` opens the studio in
// the user's default browser instead of leaving a URL for them to copy out of
// a wall of boot output.
//
// Three rules, in priority order:
//
//   1. The URL is ALWAYS printed, before any browser is launched. Auto-open is
//      the convenience; the printed line is the contract. Over SSH, inside a
//      container, on a machine with no `xdg-open`, or behind a desktop that
//      refuses the handoff, the user has already been told exactly what to
//      visit — and is told again, in one line, if the launch actually failed.
//   2. Only libi's own loopback URL is ever handed to the OS. Anything else is
//      refused (`browserOpenCommand` returns null): a browser launcher that
//      accepts arbitrary strings is an argument-injection surface, Windows'
//      `cmd /c start` most of all.
//   3. A browser that doesn't open is never an error. No stack trace, no exit
//      code, no retry loop — the server is up and serving either way, and a
//      studio that looks broken because a browser didn't launch is a worse
//      outcome than no auto-open at all. Same policy as
//      `lib/cli/update-notice.ts`.
//
// The default is ON for an installed run (`npx`, `npm i -g`) and OFF in a dev
// checkout, where the developer already has the tab open and a browser popping
// on every `npm run dev` is noise. `--open` / `--no-open` (or `LIBI_OPEN=1|0`)
// override in either direction.
import { spawn as nodeSpawn } from "node:child_process";
import http from "node:http";

/** How long to wait for the dev server to answer before giving up on the
 *  handoff. Turbopack's first compile on a cold `.next` genuinely can take
 *  most of a minute on a slow machine. */
export const READY_TIMEOUT_MS = 90_000;
export const READY_POLL_INTERVAL_MS = 400;
/** A launcher that hasn't exited by now is a foreground browser (`w3m`, a
 *  `BROWSER=` wrapper), not a failure — see `openStudioUrl`. */
export const OPEN_TIMEOUT_MS = 5_000;

const TRUTHY = new Set(["1", "true", "yes", "on"]);
const FALSY = new Set(["0", "false", "no", "off"]);

export interface OpenDecisionInput {
  /** `--open` / `--no-open`. `undefined` when the user passed neither. */
  flag?: boolean;
  env?: Record<string, string | undefined>;
  /** Dev checkouts default to OFF — see the header. */
  isDevCheckout: boolean;
  /** `--connect-agent` serves headless for someone else's CLI. */
  connectAgent?: boolean;
}

/**
 * Should this launch hand the studio to a browser? Pure — the whole decision
 * lives here so the reasons stay in one readable list instead of spread across
 * `startStudio`.
 */
export function shouldOpenBrowser({
  flag,
  env = process.env,
  isDevCheckout,
  connectAgent = false,
}: OpenDecisionInput): boolean {
  // An explicit flag wins over everything below it, including connect-agent.
  if (typeof flag === "boolean") return flag;

  const configured = env.LIBI_OPEN?.trim().toLowerCase();
  if (configured) {
    if (TRUTHY.has(configured)) return true;
    if (FALSY.has(configured)) return false;
  }

  // Headless by definition: the user is driving their own CLI elsewhere.
  if (connectAgent) return false;

  // CI runners have no desktop session; on some Linux images `xdg-open` hangs
  // rather than failing, which would burn the launch timeout on every job.
  const ci = env.CI?.trim().toLowerCase();
  if (ci && !FALSY.has(ci)) return false;

  return !isDevCheckout;
}

/** `http://localhost:3456`, `http://127.0.0.1:3456/api/runtime` — and nothing
 *  else. Deliberately strict: this is the only validation between a string and
 *  an OS-level "open this" handoff. */
const LOOPBACK_URL = /^http:\/\/(?:localhost|127\.0\.0\.1)(?::\d{1,5})?(?:\/[A-Za-z0-9\-._~/]*)?$/;

export function isLoopbackStudioUrl(url: string): boolean {
  return LOOPBACK_URL.test(url);
}

export interface BrowserCommand {
  command: string;
  args: string[];
}

/**
 * The platform's "open this URL in the default browser" command, or null when
 * the URL isn't libi's own. Never uses a shell: every argument is passed
 * through argv so nothing in the URL can be interpreted.
 */
export function browserOpenCommand(
  platform: NodeJS.Platform,
  url: string,
): BrowserCommand | null {
  if (!isLoopbackStudioUrl(url)) return null;
  if (platform === "darwin") return { command: "open", args: [url] };
  // `start`'s first quoted argument is the window TITLE, not the target — omit
  // it and a URL gets consumed as the title and nothing opens.
  if (platform === "win32") return { command: "cmd", args: ["/c", "start", "", url] };
  return { command: "xdg-open", args: [url] };
}

export interface OpenResult {
  opened: boolean;
  /** Present only when `opened` is false — one clause, printable as-is. */
  reason?: string;
}

export interface OpenStudioOptions {
  platform?: NodeJS.Platform;
  spawnImpl?: typeof nodeSpawn;
  timeoutMs?: number;
  write?: (line: string) => void;
}

/**
 * Launch the OS browser at `url`. Resolves — never rejects.
 *
 * A launcher still running at `timeoutMs` counts as SUCCESS: `open` and
 * `xdg-open` exit immediately, so a live child means the browser itself is
 * running in the foreground (terminal browsers, `BROWSER=` wrappers). Calling
 * that a failure would print "couldn't open your browser" at someone staring
 * at the studio.
 */
export function openStudioUrl(
  url: string,
  opts: OpenStudioOptions = {},
): Promise<OpenResult> {
  const platform = opts.platform ?? process.platform;
  const spawnImpl = opts.spawnImpl ?? nodeSpawn;
  const timeoutMs = opts.timeoutMs ?? OPEN_TIMEOUT_MS;

  const cmd = browserOpenCommand(platform, url);
  if (!cmd) {
    return Promise.resolve({ opened: false, reason: `refused to open ${url}` });
  }

  return new Promise<OpenResult>((resolve) => {
    let settled = false;
    const finish = (result: OpenResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    let child: ReturnType<typeof spawnImpl>;
    try {
      child = spawnImpl(cmd.command, cmd.args, {
        stdio: "ignore",
        windowsHide: true,
      });
    } catch (err) {
      return resolve({
        opened: false,
        reason: `${cmd.command} could not be launched (${err instanceof Error ? err.message : String(err)})`,
      });
    }

    const timer = setTimeout(() => {
      // Still running: a foreground browser. Let it outlive us.
      child.unref?.();
      finish({ opened: true });
    }, timeoutMs);
    timer.unref?.();

    child.on("error", (err: Error) => {
      finish({
        opened: false,
        reason: `${cmd.command} could not be launched (${err.message})`,
      });
    });
    child.on("exit", (code: number | null) => {
      if (code === 0 || code === null) return finish({ opened: true });
      finish({ opened: false, reason: `${cmd.command} exited with code ${code}` });
    });
  });
}

export interface WaitForStudioOptions {
  timeoutMs?: number;
  intervalMs?: number;
}

/**
 * Poll until THIS libi answers at `url`, or the timeout elapses.
 *
 * Probes `/api/runtime` rather than `/` and requires libi's own JSON shape
 * back. A bare "is the port accepting connections" check would happily green-
 * light a DIFFERENT server that already holds the port — the exact case where
 * our own bind is about to fail — and we'd open the user's browser on a
 * stranger's app. `/api/runtime` is a GET with no database work behind it.
 */
export function waitForStudio(
  url: string,
  opts: WaitForStudioOptions = {},
): Promise<boolean> {
  const deadline = Date.now() + (opts.timeoutMs ?? READY_TIMEOUT_MS);
  const intervalMs = opts.intervalMs ?? READY_POLL_INTERVAL_MS;
  const probe = `${url.replace(/\/$/, "")}/api/runtime`;

  return new Promise<boolean>((resolve) => {
    const attempt = (): void => {
      const req = http.get(probe, { timeout: 2_000 }, (res) => {
        let body = "";
        res.setEncoding("utf-8");
        res.on("data", (chunk: string) => {
          // A libi answer is a few dozen bytes; anything larger is not it.
          if (body.length < 4096) body += chunk;
        });
        res.on("end", () => {
          if (res.statusCode === 200 && isRuntimePayload(body)) return resolve(true);
          retry();
        });
      });
      req.on("timeout", () => req.destroy());
      req.on("error", retry);
    };

    const retry = (): void => {
      if (Date.now() >= deadline) return resolve(false);
      const timer = setTimeout(attempt, intervalMs);
      timer.unref?.();
    };

    attempt();
  });
}

/** `/api/runtime` always returns an object carrying `worktreeName` (null for a
 *  canonical checkout). That key is what identifies the answer as libi's —
 *  see `app/api/runtime/route.ts`. */
function isRuntimePayload(body: string): boolean {
  try {
    const parsed: unknown = JSON.parse(body);
    return typeof parsed === "object" && parsed !== null && "worktreeName" in parsed;
  } catch {
    return false;
  }
}

/**
 * Open the studio and, if that failed, say so in one line and repeat the URL.
 * Success is silent — the "Opening …" line was already printed at boot.
 */
export async function openStudioInBrowser(
  url: string,
  opts: OpenStudioOptions = {},
): Promise<OpenResult> {
  const write = opts.write ?? ((line: string) => process.stdout.write(line));
  const result = await openStudioUrl(url, opts);
  if (!result.opened) {
    write(
      `[libi] Couldn't open a browser (${result.reason}).\n` +
        `[libi] Open ${url} in your browser to use libi.\n`,
    );
  }
  return result;
}

/**
 * Wait for the server to answer, then open it. The dev-server path, where
 * readiness is a child process we can only observe from outside. Fire and
 * forget: this never blocks the boot it is watching.
 */
export async function openStudioWhenReady(
  url: string,
  opts: OpenStudioOptions & WaitForStudioOptions = {},
): Promise<OpenResult> {
  const write = opts.write ?? ((line: string) => process.stdout.write(line));
  const ready = await waitForStudio(url, opts);
  if (!ready) {
    write(`[libi] Gave up waiting for the studio to answer — open ${url} once it's up.\n`);
    return { opened: false, reason: "the studio never answered" };
  }
  return openStudioInBrowser(url, opts);
}
