// lib/server/next-server.ts
//
// Start the production Next.js server IN THIS PROCESS and return the port it
// bound. Extracted verbatim from `electron/main.ts#startNextServer` when the
// Electron shell stopped being the thing that owns the Next runtime.
//
// ## Why this lives in the runtime, not the shell
//
// The desktop shell no longer ships `.next`, `node_modules`, or any of libi's
// server code — it loads a published `@nagellabs/libi` runtime snapshot and
// asks IT to serve (see `electron/runtime-loader.ts` and
// `lib/runtime/shell-api.ts`). `next` itself resolves out of the runtime's own
// `node_modules`, so the require below MUST be evaluated from inside the
// runtime tree. That is the whole reason this function moved.
//
// ## Bind FIRST, prepare second
//
// (Preserved from the original, because the reasoning is still load-bearing.)
// The packaged app binds an EPHEMERAL port (`listen(0)`), but Category B —
// which writes `<LIBI_HOME>/port`, the discovery file every MCP child, job
// client, render page and the terminal WebSocket resolve the server through —
// runs inside `nextApp.prepare()` (Next.js `instrumentation.ts`). Preparing
// before binding therefore made the port UNKNOWABLE at the moment it had to be
// published, and `writePortFileAndInstallSignals()` fell back to the hardcoded
// "3456" — a port this app never listens on. On a dev machine that is a
// DIFFERENT libi instance (cross-instance DB reads/writes); on a clean machine
// nothing is there at all and every callback breaks.
//
// So: create the server, bind it, publish the real port into the env, and only
// THEN prepare Next. There is no window in which the port file can hold a wrong
// value, because it is written strictly after the bind.
//
// Requests that arrive between bind and prepare-complete are queued on `ready`
// rather than rejected — the agent/MCP children spawned by Category B itself
// can legitimately call back before `prepare()` resolves, and a connection
// refused there would be indistinguishable from the bug above. The queue is
// BOUNDED (see `READY_WAIT_TIMEOUT_MS`) so a slow Category B degrades to a
// clean 503 instead of an indefinite hang.
import { createServer } from "http";
import type http from "http";
import path from "path";
import next from "next";

import { ensureNextExternalSymlinks } from "@/lib/install/next-externals";
import { isWindows } from "@/lib/platform";
import { describeFarmBeforeBoot, inspectFarmBeforeBoot, logBootTiming } from "@/lib/server/lifecycle/boot-timing";

export interface StartNextServerOptions {
  /**
   * The Next.js project root — the directory containing `.next/`, `public/`
   * and (for a runtime snapshot) the package's own `node_modules` ancestor
   * chain. For the packaged app this is the resolved runtime root, NOT the
   * Electron app directory.
   */
  dir: string;
  /** Breadcrumb sink. The Electron shell passes its durable sync log. */
  log?: (message: string) => void;
  /**
   * How long a request that arrives before `prepare()` resolves may park.
   * Exposed for tests; the default matches the original shell behaviour.
   */
  readyWaitTimeoutMs?: number;
}

export interface StartedNextServer {
  port: number;
  /** The bound HTTP server, so a caller can close it on shutdown. */
  server: http.Server;
}

const DEFAULT_READY_WAIT_TIMEOUT_MS = 60_000;

export async function startNextServer(
  opts: StartNextServerOptions,
): Promise<StartedNextServer> {
  const { dir } = opts;
  const log = opts.log ?? (() => {});
  const readyWaitTimeoutMs = opts.readyWaitTimeoutMs ?? DEFAULT_READY_WAIT_TIMEOUT_MS;

  // Activate `next-logger` HERE, before `next()` is constructed — not only from
  // `instrumentation.ts#register()`.
  //
  // `register()` is Next's documented hook, but Next calls it during its own
  // startup, i.e. AFTER the framework has already emitted its configuration and
  // workspace-resolution diagnostics. Measured on a packaged boot: the two
  // warnings Next printed ("inferred your workspace root…", "`next start` does
  // not work with `output: standalone`") went to the app's stdout and never
  // reached `~/.libi/logs/server.log`, which shipped 0 bytes. Those early lines
  // are precisely the ones worth having on disk when a packaged app misbehaves,
  // since a user has no terminal to read them from.
  //
  // Importing it here is idempotent with the `register()` call (Node caches the
  // module). This is the packaged Electron launch (via `shell-api`); `npx` runs
  // its own production server in `lib/cli/studio.ts#runProductionServer`, which
  // makes the same early import (it did not until EL-5, and its server.log
  // stayed empty). Failure is non-fatal for the same reason as in
  // `register()`: logging must never be what stops the server booting.
  try {
    await import("next-logger");
  } catch (err) {
    log(
      `startNextServer: next-logger failed to load — server.log will not be written: ${
        (err as Error)?.message ?? String(err)
      }`,
    );
  }

  // Turbopack resolves `serverExternalPackages` through a symlink farm at
  // `.next/node_modules/`. npm strips symlinks from every tarball, so a runtime
  // installed from the registry arrives with that directory EMPTY and the
  // server 500s every route. Recreating it from the recorded manifest is what
  // makes an installed runtime servable at all. Every failure mode in here
  // throws loudly on purpose — see lib/install/next-externals.ts.
  //
  // On macOS, for the two runtimes this function actually serves — the
  // snapshot inside the .app and a fetched `<LIBI_HOME>/runtime/<v>/` — the
  // farm was already materialised at bundle-build / install time, so this call
  // is a pure verify and `created` MUST be 0. Windows is the exception, below:
  // its installer ships no farm at all. A non-zero `created` here means the
  // shipped farm was missing or wrong and we just wrote into the (signed,
  // possibly read-only) app bundle to repair it: worth seeing in the log
  // rather than discovering as a codesign failure later.
  //
  // Wrapped so the failure is not silent. When this threw on Windows (the
  // privileged-symlink bug fixed in lib/install/next-externals.ts) the shell
  // logged "about to startNextServer" and then NOTHING — the process died
  // between two lines, leaving a splash screen that never resolves and no
  // evidence of why. The throw is still fatal, and should be: a server that
  // cannot resolve its externals 500s every route. It just says so first.
  let externals: ReturnType<typeof ensureNextExternalSymlinks>;
  const farmBefore = inspectFarmBeforeBoot(path.join(dir, ".next"));
  const farmStarted = Date.now();
  try {
    externals = ensureNextExternalSymlinks(path.join(dir, ".next"));
  } catch (err) {
    log(
      `startNextServer: FATAL — could not materialise the Next.js externals farm at ` +
        `${path.join(dir, ".next", "node_modules")}: ${err instanceof Error ? err.message : String(err)}`,
    );
    throw err;
  }
  const farmMs = Date.now() - farmStarted;
  // A non-zero `created` is a WARNING on macOS and NORMAL on a Windows first
  // boot, and the line says which so nobody re-investigates the Windows case.
  // The Windows installer ships NO farm: electron-builder would copy the
  // build-time junctions as dereferenced real directories (883 files on
  // 0.1.16), which this call then had to delete one by one, so the afterPack
  // hook (scripts/afterpack.js -> scripts/afterpack-windows-externals.js:38-40)
  // strips `resources/libi-bundle/node_modules/@nagellabs/libi/.next/node_modules`
  // (the runtime root, via `runtimeRootFor` in scripts/build-runtime-bundle.js)
  // from the Windows payload. The first boot builds the farm as junctions into
  // the per-user install, which is neither signed nor read-only; later boots
  // only verify it.
  const expectedRepair = isWindows();
  log(
    `startNextServer: externals created=${externals.created.length} verified=${externals.verified.length} in ${farmMs}ms ${describeFarmBeforeBoot(farmBefore)}` +
      (externals.created.length === 0
        ? ""
        : expectedRepair
          ? ` — built ${externals.created.length} externals junction(s) at boot, as a Windows first boot must (the installer ships no farm)`
          : ` — WARNING: repaired ${externals.created.length} externals symlink(s) at boot; a packaged runtime should ship this farm already built`),
  );

  // `ready` is a manually-resolved deferred, created and assigned BEFORE
  // `server.listen()`. A `let ready!: Promise<void>` assigned after the bind
  // was a TDZ hazard: a request arriving in that window — or a synchronous
  // throw from `next()` itself (e.g. a bad `dir`) — would dereference
  // `undefined.then(...)` and crash out as an uncaughtException instead of a
  // clean 503.
  let handle: ((req: http.IncomingMessage, res: http.ServerResponse) => void) | null =
    null;
  let resolveReady!: () => void;
  let rejectReady!: (err: unknown) => void;
  const ready: Promise<void> = new Promise((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });

  const server = createServer((req, res) => {
    if (handle) {
      handle(req, res);
      return;
    }
    let timer: NodeJS.Timeout;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error(`server not ready after ${readyWaitTimeoutMs}ms`)),
        readyWaitTimeoutMs,
      );
    });
    Promise.race([ready, timeout])
      .then(() => {
        clearTimeout(timer);
        handle?.(req, res);
      })
      .catch((err) => {
        clearTimeout(timer);
        log(`startNextServer: request before ready failed: ${(err as Error).message}`);
        try {
          res.statusCode = 503;
          res.end("libi is still starting");
        } catch {
          /* socket already gone */
        }
      });
  });

  const port = await new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      const addr = server.address();
      resolve(typeof addr === "object" && addr ? addr.port : 3000);
    });
  });
  const portAt = Date.now();
  // Both are read downstream: `writePortFileAndInstallSignals()` (Category B)
  // prefers PORT; `getCurrentPort()` falls back to LIBI_PORT when the port file
  // is missing. Set them together so neither can disagree with the bind.
  process.env.PORT = String(port);
  process.env.LIBI_PORT = String(port);
  log(`startNextServer: bound 127.0.0.1:${port}, preparing Next from ${dir}`);

  // `port` and `hostname` are not bind options here — this server is already
  // bound — they are what Next synthesizes every handler's `request.url` (and
  // `nextUrl`, `x-forwarded-port`) from. Left out, Next falls back to
  // `localhost:3000`, a port this app never serves: that is how Social's
  // "Connect libi" sent Zernio's callback to `127.0.0.1:3000` (SOC-3). Routes
  // still take the studio port from `getCurrentPort()`, never `request.url`;
  // this only keeps the URL Next hands them honest.
  const nextApp = next({ dev: false, dir, port, hostname: "127.0.0.1" });
  nextApp
    .prepare()
    .then(() => {
      handle = nextApp.getRequestHandler();
      resolveReady();
    })
    .catch((err) => {
      rejectReady(err);
    });
  await ready;
  logBootTiming({
    surface: "electron",
    farmMs,
    farmCreated: externals.created.length,
    farmVerified: externals.verified.length,
    ...farmBefore,
    portAt,
    readyAt: Date.now(),
  });
  return { port, server };
}
