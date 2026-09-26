// lib/storyboard/render/lock-runtime.ts
//
// Closes the storyboard render worker's reach BEFORE an agent-authored body
// runs. Node's permission model gates fs writes and child processes but not the
// network, and `validateDrawFunction`'s denylist is a text filter a body can
// step around by building a string at runtime. With `process` or a module
// loader in reach, a body could open node:http and speak to libi's own loopback
// routes with forged browser headers — including the template publish confirm
// (lib/approval/extensions.ts LIMITATIONS).
//
// So, once the worker has loaded everything it renders with:
//   - every further module resolution is refused (`module.registerHooks`, which
//     also covers `require` and a runtime-built `import()`), and
//   - the global `process` becomes a frozen stand-in holding data only (an empty
//     `env`, the platform and version strings), so neither a body nor a
//     Function it builds can reach `process.binding`, `getBuiltinModule`,
//     `dlopen` or the streams. Data only, because satori still reads
//     `process.env` on every render.
// The worker keeps only the three I/O calls it needs, captured here first.
//
// Fail closed: a Node without `registerHooks` (added in 22.15 / 23.5) cannot be
// locked, and the worker refuses to render rather than run a body unlocked.
import * as nodeModule from "node:module";

export interface WorkerIo {
  writeStdout(bytes: Buffer): Promise<void>;
  writeStderr(text: string): void;
  exit(code: number): never;
}

export const MODULE_LOADING_CLOSED = "module loading is closed in the storyboard render worker";

type RegisterHooks = (hooks: { resolve: () => never }) => unknown;

/** `registerHooks` is a parameter only so a test can take the fail-closed path
 *  without locking the test runner itself. */
export function lockWorkerRuntime(
  registerHooks: RegisterHooks | null | undefined = (nodeModule as { registerHooks?: RegisterHooks }).registerHooks,
): WorkerIo {
  const proc = process;
  if (typeof registerHooks !== "function") {
    throw new Error(
      `this Node (${proc.version}) cannot lock its module loader (module.registerHooks needs Node 22.15+), so the sketch is not rendered`,
    );
  }
  const io: WorkerIo = {
    writeStdout: (bytes) =>
      new Promise<void>((resolve, reject) => {
        proc.stdout.write(bytes, (err) => (err ? reject(err) : resolve()));
      }),
    writeStderr: (text) => {
      proc.stderr.write(text);
    },
    exit: (code) => proc.exit(code),
  };

  registerHooks({
    resolve: () => {
      throw new Error(MODULE_LOADING_CLOSED);
    },
  });
  Object.defineProperty(globalThis, "process", {
    value: processStandIn(proc),
    writable: false,
    configurable: false,
    enumerable: false,
  });
  return io;
}

/** What the render stack reads from `process` after the lock (satori reads
 *  `process.env.*`), and nothing callable. */
function processStandIn(proc: NodeJS.Process): object {
  return Object.freeze({
    env: Object.freeze({}),
    platform: proc.platform,
    arch: proc.arch,
    version: proc.version,
    versions: Object.freeze({ ...proc.versions }),
  });
}
