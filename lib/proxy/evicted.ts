import fs from "node:fs";
import path from "node:path";
import { getLibiHome } from "@/lib/libi-home";

/**
 * Proxies the LRU budget evicted, by file id: the evidence the re-make on open
 * (ensure.ts) needs (review I2). An `idle` row with no proxy is otherwise the
 * same whether its proxy was evicted or never made on purpose: the onboarding
 * clips are stored with `skipProxyGeneration`, so a proxy landing never
 * switches a first-time user's film mid-playback. Only a file listed here is
 * re-made.
 *
 * `<LIBI_HOME>/state/proxy-evicted.json` = `{ [fileId]: { bytes, at } }`:
 * `bytes` is the evicted proxy's size, which the re-make uses to tell whether
 * the open piece's proxies fit the budget at all (review I3). Written by
 * `dropProxyFile(…, "lru")` (and, once, backfill-evicted.ts); an entry goes when the re-make COMPLETES, when the
 * proxy is dropped for any other reason (a deleted file, a user's drop), and
 * when its row no longer exists (pruned by the LRU pass). Every write is a
 * temp file + rename, so a crash never leaves it half written. The MCP child
 * can drop proxies too (a user's drop, a file delete): two processes may
 * write it, and the later rename wins, which at worst forgets or keeps one
 * entry.
 */
export interface EvictedProxy {
  bytes: number;
  /** Unix ms. */
  at: number;
}

export const EVICTED_PROXIES_FILE = "proxy-evicted.json";

type Store = Record<string, EvictedProxy>;

function storePath(): string {
  return path.join(getLibiHome(), "state", EVICTED_PROXIES_FILE);
}

export function listEvictedProxies(): Store {
  try {
    const v = JSON.parse(fs.readFileSync(storePath(), "utf8")) as unknown;
    if (!v || typeof v !== "object" || Array.isArray(v)) return {};
    const out: Store = {};
    for (const [id, e] of Object.entries(v as Record<string, unknown>)) {
      const bytes = (e as EvictedProxy | null)?.bytes;
      const at = (e as EvictedProxy | null)?.at;
      if (typeof bytes === "number" && bytes >= 0 && typeof at === "number") out[id] = { bytes, at };
    }
    return out;
  } catch {
    return {};
  }
}

function write(store: Store): void {
  const file = storePath();
  if (Object.keys(store).length === 0) {
    fs.rmSync(file, { force: true });
    return;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(store)}\n`);
  fs.renameSync(tmp, file);
}

/** Record that the LRU evicted `fileId`'s proxy of `bytes`. */
export function recordEvictedProxy(fileId: string, bytes: number): void {
  const store = listEvictedProxies();
  store[fileId] = { bytes, at: Date.now() };
  write(store);
}

/** Forget these files' evictions (re-made, dropped for another reason, or gone). */
export function forgetEvictedProxies(fileIds: Iterable<string>): void {
  const store = listEvictedProxies();
  let changed = false;
  for (const id of fileIds) {
    if (id in store) {
      delete store[id];
      changed = true;
    }
  }
  if (changed) write(store);
}
