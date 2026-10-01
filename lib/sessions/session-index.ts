import fs from "node:fs";
import path from "node:path";
import { getLibiHome } from "@/lib/libi-home";

/**
 * libi's own index of the chats it has shown: `{ sessionId, agentId, title, updatedAt }`.
 *
 * The sidebar's list comes from the agent's `session/list`, which only knows transcripts that
 * exist. A chat whose transcript was deleted or moved therefore vanished from the sidebar on the
 * next start, and the "This chat's history isn't on this computer any more" note (0.1.16) could be
 * reached only while the chat was still in memory (full-verification F10). With this index, an id
 * the agent no longer lists stays in the list for a while (`MISSING_WINDOW_MS`) as an UNLISTED row.
 * Being unlisted is not proof the history is gone — Codex's listing filters by model provider and
 * hides archived threads — so opening the row still tries the load, and only the agent's own
 * rejection says "history missing" (`SessionManager`).
 *
 * `hasTranscript` is set once the agent has LISTED or LOADED the chat — evidence a transcript
 * existed. A chat that was only created (never prompted, so never written to disk) is not "missing"
 * when it is gone, it never had any history: it is pruned, not surfaced.
 *
 * `missingSince` is when a successful listing first left the chat out; the entry is dropped once
 * that is older than `MISSING_WINDOW_MS`, so transcripts the agent cleans up (Claude Code's
 * `cleanupPeriodDays`) don't pile up in the sidebar. A listing that has it again clears it.
 *
 * `<LIBI_HOME>/state/session-index.json` = `{ version: 1, sessions: { [sessionId]: {…} } }`, mode
 * 0600: a title can be the chat's first prompt (Codex titles a thread by its preview), and it
 * outlives the transcript for up to the window above. Read once per process and cached; every write
 * goes through to the file as a temp file + rename, so a crash never leaves it half written. Only
 * the studio server writes it (the SessionManager singleton). Not piece-scoped: piece DELETE doesn't
 * touch it.
 */
export interface SessionIndexEntry {
  sessionId: string;
  agentId: string;
  title: string | null;
  updatedAt: string | null;
  hasTranscript: boolean;
  /** ISO time a successful listing first left this chat out; null while it is listed. */
  missingSince: string | null;
}

/** An upsert. `title` / `updatedAt` null keep what the entry had; `hasTranscript` only ever turns
 *  on; `missingSince` undefined keeps it, null clears it. */
export interface SessionIndexUpsert {
  sessionId: string;
  agentId: string;
  title: string | null;
  updatedAt: string | null;
  hasTranscript: boolean;
  missingSince?: string | null;
}

export interface SessionIndex {
  list(): SessionIndexEntry[];
  record(entries: SessionIndexUpsert[]): void;
  /** Drop these ids. Returns how many were there. */
  remove(sessionIds: Iterable<string>): number;
}

export const SESSION_INDEX_FILE = "session-index.json";

/** A created-but-never-transcribed entry older than this is dropped on the next write, so an agent
 *  that never lists its sessions can't grow the file without bound. */
export const UNTRANSCRIBED_ENTRY_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** How long a chat the agent stopped listing stays in the sidebar before its entry is dropped. */
export const MISSING_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

export function defaultSessionIndexPath(): string {
  return path.join(getLibiHome(), "state", SESSION_INDEX_FILE);
}

type Stored = Omit<SessionIndexEntry, "sessionId">;

function readStore(file: string): Map<string, Stored> {
  const out = new Map<string, Stored>();
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return out;
  }
  const sessions = (parsed as { sessions?: unknown } | null)?.sessions;
  if (!sessions || typeof sessions !== "object" || Array.isArray(sessions)) return out;
  for (const [id, raw] of Object.entries(sessions as Record<string, unknown>)) {
    const e = raw as Partial<Stored> | null;
    if (!id || !e || typeof e.agentId !== "string") continue;
    out.set(id, {
      agentId: e.agentId,
      title: typeof e.title === "string" ? e.title : null,
      updatedAt: typeof e.updatedAt === "string" ? e.updatedAt : null,
      hasTranscript: e.hasTranscript === true,
      missingSince: typeof e.missingSince === "string" ? e.missingSince : null,
    });
  }
  return out;
}

function writeStore(file: string, store: Map<string, Stored>): void {
  if (store.size === 0) {
    fs.rmSync(file, { force: true });
    return;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify({ version: 1, sessions: Object.fromEntries(store) })}\n`, { mode: 0o600 });
  // `mode` applies only when the file is created; a temp file left by a crash keeps its own.
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);
}

function isStaleUntranscribed(e: Stored, now: number): boolean {
  if (e.hasTranscript) return false;
  const at = e.updatedAt ? Date.parse(e.updatedAt) : NaN;
  return Number.isFinite(at) && now - at > UNTRANSCRIBED_ENTRY_TTL_MS;
}

/** The index as a JSON file, cached in memory after the first read. I/O errors are thrown;
 *  `SessionManager` logs and carries on. */
export function fileSessionIndex(file: string = defaultSessionIndexPath()): SessionIndex {
  let cache: Map<string, Stored> | null = null;
  const store = (): Map<string, Stored> => (cache ??= readStore(file));
  /** Write a changed copy, and adopt it only once it is on disk. */
  const commit = (next: Map<string, Stored>): void => {
    writeStore(file, next);
    cache = next;
  };
  return {
    list() {
      return [...store()].map(([sessionId, e]) => ({ sessionId, ...e }));
    },
    record(entries) {
      if (entries.length === 0) return;
      const next = new Map(store());
      let changed = false;
      for (const e of entries) {
        const prev = next.get(e.sessionId);
        const rec: Stored = {
          agentId: e.agentId,
          title: e.title ?? prev?.title ?? null,
          updatedAt: e.updatedAt ?? prev?.updatedAt ?? null,
          hasTranscript: e.hasTranscript || prev?.hasTranscript === true,
          missingSince: e.missingSince === undefined ? (prev?.missingSince ?? null) : e.missingSince,
        };
        if (
          !prev ||
          prev.agentId !== rec.agentId ||
          prev.title !== rec.title ||
          prev.updatedAt !== rec.updatedAt ||
          prev.hasTranscript !== rec.hasTranscript ||
          prev.missingSince !== rec.missingSince
        ) {
          next.set(e.sessionId, rec);
          changed = true;
        }
      }
      if (!changed) return;
      const now = Date.now();
      for (const [id, e] of next) if (isStaleUntranscribed(e, now)) next.delete(id);
      commit(next);
    },
    remove(sessionIds) {
      const next = new Map(store());
      let removed = 0;
      for (const id of sessionIds) if (next.delete(id)) removed++;
      if (removed > 0) commit(next);
      return removed;
    },
  };
}
