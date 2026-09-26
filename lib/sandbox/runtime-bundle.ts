import { createBundleCache, hashBundleCode, type BrowserBundle } from "@/lib/bundles/browser-bundle";

const TTL_MS = process.env.NODE_ENV === "production" ? 24 * 60 * 60 * 1000 : 5_000;
/**
 * No sourcemap in production. The served runtime bundle carries the worker's
 * whole source a second time (as the JSON string the supervisor turns into a
 * blob), so an inline map is paid for twice — it took the bundle to 3.6 MB.
 * In dev it stays on: it is the only way a stack from inside the worker names
 * a file. The render bundle keeps its own behaviour.
 */
const SOURCEMAP: "inline" | false = process.env.NODE_ENV === "production" ? false : "inline";
const workerCache = createBundleCache("lib/sandbox/runtime-entry.ts", TTL_MS, { sourcemap: SOURCEMAP });
const supervisorCache = createBundleCache("lib/sandbox/supervisor-entry.ts", TTL_MS, { sourcemap: SOURCEMAP });

/** The worker alone (the in-origin dev mode spawns it as a same-origin blob worker). */
export function getOverlayWorkerBundle(): Promise<BrowserBundle> {
  return workerCache.get();
}

/**
 * The supervisor script with the worker source embedded as a JSON string
 * constant. The supervisor page runs under `connect-src 'none'` and cannot
 * fetch, so the worker's source travels inside the one script the page may
 * load; the supervisor turns it into a blob: URL (spec A1).
 */
export async function getOverlayRuntimeBundle(): Promise<BrowserBundle> {
  const [worker, supervisor] = await Promise.all([workerCache.get(), supervisorCache.get()]);
  // Composed and hashed once per pair of builds (final security review, M3):
  // re-hashing ~5 MB on every GET let a body's `importScripts(<bundle>?<x>)`
  // loop make the server do that work per request.
  if (composed && composed.worker === worker && composed.supervisor === supervisor) return composed.bundle;
  const code = `const __LIBI_WORKER_SOURCE__ = ${JSON.stringify(worker.code)};\n${supervisor.code}`;
  const bundle: BrowserBundle = {
    code,
    hash: hashBundleCode(code),
    bytes: code.length,
    durationMs: worker.durationMs + supervisor.durationMs,
  };
  composed = { worker, supervisor, bundle };
  return bundle;
}

let composed: { worker: BrowserBundle; supervisor: BrowserBundle; bundle: BrowserBundle } | null = null;
