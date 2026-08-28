// lib/storyboard/render/index.ts
import fs from "fs";
import path from "path";
import { spawn } from "child_process";
import { serverLogger as logger } from "@/lib/logger";
import { resolveNodeCommand } from "@/lib/runtime/node-runtime";
import {
  compiledEntryPath,
  entryResolutionDiagnostic,
  isInstalledUnderNodeModules,
} from "@/lib/runtime/compiled-entry";
import type { RenderFrame } from "./hyperscript";
import type { RenderUnitKind } from "../types";

export type { RenderUnitKind };

/** Hard cap on a single sketch render. A runaway body (infinite loop) is killed. */
const RENDER_TIMEOUT_MS = 20_000;

/** Node ≥20.6 spells the permission-model flag `--permission`; 20.0–20.5 used
 *  the older `--experimental-permission`. Detect from the running Node version. */
function permissionFlag(): string {
  const [major, minor] = process.version.replace(/^v/, "").split(".").map(Number);
  if (major > 20) return "--permission";
  if (major === 20 && minor >= 6) return "--permission";
  return "--experimental-permission";
}

/** Provider/API secrets the untrusted render worker never needs. Stripped from
 *  its env before spawn (defense-in-depth: even a denylist-bypassing body that
 *  manages to read `process.env` finds no secret present). */
const WORKER_ENV_SECRET_DENYLIST = new Set([
  "FAL_KEY",
  "FAL_AI_KEY",
  "FAL_API_KEY_ADMIN_SCOPE",
  "ELEVENLABS_API_KEY",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "GITHUB_TOKEN",
  "GIT_TOKEN",
]);

/** Suffix patterns for secret-shaped keys not caught by the explicit denylist. */
const WORKER_ENV_SECRET_SUFFIXES = ["_API_KEY", "_TOKEN", "_SECRET"] as const;

function isSecretEnvKey(key: string): boolean {
  const upper = key.toUpperCase();
  if (WORKER_ENV_SECRET_DENYLIST.has(upper)) return true;
  return WORKER_ENV_SECRET_SUFFIXES.some((suffix) => upper.endsWith(suffix));
}

/** Exact env-var names the render worker legitimately needs for the Node/tsx
 *  runtime to boot. `worker-entry.ts` reads NOTHING from `process.env` itself
 *  (its job arrives on stdin), so nothing app-level belongs here — only the
 *  runtime/OS plumbing that lets the permission-restricted child start. Windows
 *  casings included alongside the POSIX names. */
const WORKER_ENV_ALLOWLIST = new Set([
  "PATH",
  "Path",
  "HOME",
  "USERPROFILE",
  "TMPDIR",
  "TEMP",
  "TMP",
  "NODE_ENV",
  "NODE_OPTIONS",
  "NODE_PATH",
  "LIBI_HOME",
  "TSX_DISABLE_CACHE",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "PWD",
  "SHELL",
  "USER",
  "LOGNAME",
  "ELECTRON_RUN_AS_NODE",
  "SYSTEMROOT",
  "SystemRoot",
  "windir",
  "WINDIR",
  "COMSPEC",
  "PATHEXT",
  "APPDATA",
  "LOCALAPPDATA",
]);

/** Prefixes for families of runtime vars the worker may need (tsx/esbuild/Node
 *  tuning, locale, XDG base dirs). Deliberately NOT `npm_` — npm injects
 *  `npm_config__authToken`-style secrets. */
const WORKER_ENV_ALLOWLIST_PREFIXES = ["TSX_", "NODE_", "LC_", "ESBUILD_", "XDG_"] as const;

function isAllowlistedEnvKey(key: string): boolean {
  if (WORKER_ENV_ALLOWLIST.has(key)) return true;
  return WORKER_ENV_ALLOWLIST_PREFIXES.some((prefix) => key.startsWith(prefix));
}

/** Return a copy of `env` restricted to what the render worker legitimately
 *  needs. Two layers, defense-in-depth:
 *   1. **Allowlist (primary):** a key survives only if it is an exact-name match
 *      OR matches an allowlist prefix. Any unanticipated var — including a NEW
 *      secret whose name isn't secret-shaped — is dropped by default, so future
 *      env additions can never leak into the untrusted subprocess.
 *   2. **Secret denylist (second layer):** over what the allowlist admitted, the
 *      `isSecretEnvKey` denylist still strips a secret-shaped key that slipped in
 *      via an allowlisted prefix.
 *  Pure. The worker inherits only the Node/tsx runtime plumbing (PATH, HOME,
 *  NODE*, TSX*, TMPDIR, LIBI_HOME) — no provider credentials it would never use. */
export function sanitizeWorkerEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env };
  for (const key of Object.keys(out)) {
    // layer 1: allowlist (primary) — drop anything not explicitly permitted.
    // layer 2: secret denylist (belt-and-braces) — drop an allowlisted-prefix
    //          key that is nonetheless secret-shaped.
    if (isAllowlistedEnvKey(key) && !isSecretEnvKey(key)) continue;
    delete out[key];
  }
  return out;
}

/** Source path of the render worker's entry, relative to libi's package root.
 *  `scripts/build-cli.js` compiles the whole of `lib/` + `mcp/`, so its compiled
 *  twin ships at `dist-cli/lib/storyboard/render/worker-entry.js`. */
const WORKER_ENTRY_REL = "lib/storyboard/render/worker-entry.ts";

/** Bound on the ancestor walk in `workerReadScopes` — deep enough for any real
 *  layout, finite so a pathological path can't spin. */
const READ_SCOPE_MAX_DEPTH = 12;

/**
 * Filesystem read scopes granted to the worker in COMPILED mode.
 *
 * The project root alone is NOT enough, and quietly was not: npm HOISTS, so an
 * installed copy at `<x>/node_modules/@nagellabs/libi` has its dependencies —
 * `@napi-rs/canvas`, `@resvg/resvg-js`, `satori`, `roughjs` — in `<x>/node_modules`,
 * a SIBLING of the project root rather than a child of it. Under `--permission`
 * the module loader's own `readPackageJSON` is permission-checked, so the worker
 * died at the first `require` with `ERR_ACCESS_DENIED` before rendering anything.
 * (Verified against the packaged app: project-root-only scope → exit 1 at
 * `node:internal/modules/package_json_reader`; adding the hoisted root → a valid
 * PNG.)
 *
 * So: the project root, plus every `node_modules` directory on the path from it
 * up to the filesystem root. Read-only in every case — this widens WHAT can be
 * read, never what can be written or executed.
 *
 * Pure apart from the injectable existence probe, which is what makes the layout
 * cases (hoisted, nested, dev checkout) testable without a real tree.
 */
export function workerReadScopes(
  projectRoot: string,
  exists: (p: string) => boolean = fs.existsSync,
): string[] {
  const scopes = [projectRoot];
  let dir = projectRoot;
  for (let i = 0; i < READ_SCOPE_MAX_DEPTH; i++) {
    const nodeModules = path.join(dir, "node_modules");
    if (exists(nodeModules) && !scopes.includes(nodeModules)) scopes.push(nodeModules);
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return scopes;
}

/** Resolve how to launch the isolated render worker.
 *
 *  Two modes, selected by the same rule as every other libi self-spawn
 *  (`lib/runtime/compiled-entry.ts`): a source checkout runs the `.ts` worker
 *  through tsx; a copy installed UNDER `node_modules` — the packaged Electron app
 *  and `npx @nagellabs/libi` alike — runs the compiled
 *  `dist-cli/lib/storyboard/render/worker-entry.js`, because tsx refuses to apply
 *  the tsconfig `paths` matcher to any file under a `node_modules` segment and
 *  this render tree imports `@/lib/ai/scene-validator` + `@/lib/engine/draw-helpers`.
 *
 *  `command` is `resolveNodeCommand()` — a REAL node — in both modes, never
 *  `process.execPath`. Under the packaged app that is the Electron binary, and
 *  `electronFuses.runAsNode: false` makes it ignore `ELECTRON_RUN_AS_NODE`:
 *  spawning it launched a second full Libi GUI which never wrote a byte to stdout,
 *  so every packaged storyboard render died on the 20s timeout below. Same defect,
 *  same fix, as `lib/install/npm-root.ts` and `lib/runtime/compiled-entry.ts`.
 *
 *  The permission model is what actually closes the RCE — we grant ONLY what
 *  rendering needs:
 *   - `--allow-addons` — the render stack (`@napi-rs/canvas`, `@resvg/resvg-js`,
 *     satori) are native addons. The untrusted body cannot load its own addons
 *     (no require/import; `process` is denylisted), so this stays safe.
 *   - `--allow-fs-read` — reading is not the RCE vector (write/child_process are;
 *     network exfil is closed by stripping fetch/WebSocket/XHR IN the worker —
 *     see worker-entry.ts — because CSP does NOT apply to a Node process).
 *     Compiled mode grants the project root plus the `node_modules` roots its
 *     dependencies actually resolve from (see `workerReadScopes`); dev grants `*`
 *     because tsx's tsconfig case-sensitivity probe reads a case-flipped path and
 *     esbuild resolves modules broadly.
 *   - `--allow-worker` (DEV ONLY) — tsx's esbuild transform runs in a worker
 *     thread. A worker INHERITS the parent's permission set and cannot escalate,
 *     so it still has no fs-write / child_process — the RCE boundary is intact.
 *  NO `--allow-fs-write`, NO `--allow-child-process` in either mode. That is the
 *  whole boundary; do not add either to make some future spawn resolve.
 *
 *  Throws when neither mode resolves. The old code returned a path nothing
 *  produces (`lib/storyboard/render/worker-entry.js`) and let the spawn hang for
 *  the full 20s timeout; a missing worker should be an immediate, named failure. */
export function resolveWorkerSpawn(
  projectRoot: string = process.cwd(),
): { command: string; args: string[]; env: NodeJS.ProcessEnv } {
  const tsEntry = path.join(projectRoot, WORKER_ENTRY_REL);
  // The `node_modules/.bin/tsx` shim is a symlink electron-builder does not copy;
  // probe the real CLI file instead, exactly as `resolveEntrySpawn` does.
  const tsxCli = path.join(projectRoot, "node_modules", "tsx", "dist", "cli.mjs");
  const perm = permissionFlag();

  if (
    !isInstalledUnderNodeModules(projectRoot) &&
    fs.existsSync(tsEntry) &&
    fs.existsSync(tsxCli)
  ) {
    // Dev / source-tree: run the TypeScript worker through tsx. `--import tsx`
    // rather than running tsx's own CLI, deliberately: the CLI re-spawns node,
    // which would need `--allow-child-process` — the one flag this boundary
    // cannot give away.
    return {
      command: resolveNodeCommand(),
      args: [
        perm,
        "--allow-addons",
        "--allow-worker",
        "--allow-fs-read=*",
        "--no-warnings",
        "--import",
        "tsx",
        tsEntry,
      ],
      // TSX_DISABLE_CACHE: tsx's on-disk transform cache write is blocked by the
      // permission model (no fs-write); disabling it keeps the worker startable.
      env: sanitizeWorkerEnv({ ...process.env, TSX_DISABLE_CACHE: "1" }),
    };
  }

  // Packaged / installed: run the compiled JS worker directly (no worker flag
  // needed — that was purely a tsx/esbuild requirement).
  const jsEntry = compiledEntryPath(projectRoot, WORKER_ENTRY_REL);
  if (!fs.existsSync(jsEntry)) {
    throw new Error(
      `storyboard render worker not found — ${entryResolutionDiagnostic(projectRoot, WORKER_ENTRY_REL)}`,
    );
  }
  return {
    command: resolveNodeCommand(),
    args: [
      perm,
      "--allow-addons",
      ...workerReadScopes(projectRoot).map((scope) => `--allow-fs-read=${scope}`),
      "--no-warnings",
      jsEntry,
    ],
    env: sanitizeWorkerEnv({ ...process.env }),
  };
}

/** Validate + render an agent-authored unit body to a PNG buffer, dispatching
 *  by kind. Throws on a disallowed/invalid body or an unknown kind.
 *
 *  SECURITY (RC-C): the untrusted body is NO LONGER executed in this (the
 *  Next.js server) process. It is run in a permission-restricted child process
 *  (`worker-entry.ts`) that has no fs-write and no child_process capability, so
 *  a denylist bypass cannot become RCE. Validation + `new Function` compilation
 *  both happen inside that worker.
 *
 *  @param extra  Optional additional context injected into the render context
 *               (e.g. `{ blocks, camera }` from the card). Serializable only —
 *               it is JSON-encoded across the process boundary. Back-compatible;
 *               defaults to `{}` when omitted. */
export async function renderUnitToPng(
  kind: RenderUnitKind,
  source: string,
  frame: RenderFrame,
  extra?: Record<string, unknown>,
): Promise<Buffer> {
  const job = JSON.stringify({ kind, source, frame, extra: extra ?? {} });
  const { command, args, env } = resolveWorkerSpawn();

  return await new Promise<Buffer>((resolve, reject) => {
    const child = spawn(command, args, {
      env,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      logger.warn({ tag: "security", op: "storyboard_render_timeout", kind }, "render worker timed out");
      reject(new Error(`render worker timed out after ${RENDER_TIMEOUT_MS}ms`));
    }, RENDER_TIMEOUT_MS);

    child.stdout.on("data", (d: Buffer) => stdoutChunks.push(d));
    child.stderr.on("data", (d: Buffer) => stderrChunks.push(d));

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) {
        const out = Buffer.concat(stdoutChunks);
        // Integrity guard: the worker writes raw PNG bytes to stdout. If a stray
        // dependency logged to fd 1 (corrupting the stream) or the worker somehow
        // exited 0 with no image, the buffer won't start with the PNG signature
        // (\x89 P N G). Reject clearly rather than hand back a broken buffer.
        if (
          out.length < 8 ||
          out[0] !== 0x89 ||
          out[1] !== 0x50 ||
          out[2] !== 0x4e ||
          out[3] !== 0x47
        ) {
          reject(
            new Error(
              `render worker returned invalid PNG output (${out.length} bytes, bad signature)`,
            ),
          );
          return;
        }
        resolve(out);
        return;
      }
      const stderr = Buffer.concat(stderrChunks).toString("utf8").trim();
      // The worker emits a JSON error line on stderr; surface its message.
      let message = stderr || `render worker exited with code ${code}`;
      const lastLine = stderr.split("\n").filter(Boolean).pop();
      if (lastLine) {
        try {
          const parsed = JSON.parse(lastLine) as { error?: string };
          if (parsed?.error) message = parsed.error;
        } catch {
          // not JSON — keep raw stderr
        }
      }
      reject(new Error(message));
    });

    child.stdin.on("error", () => {
      /* ignore EPIPE if the worker exits before we finish writing */
    });
    child.stdin.write(job);
    child.stdin.end();
  });
}

export type { RenderFrame };
