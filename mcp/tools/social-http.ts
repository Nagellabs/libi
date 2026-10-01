/**
 * The social tools' one way to reach the studio: `libi.social_status`,
 * `libi.post_piece`, `libi.social_link_post` (social-tools.ts) and
 * `libi.social_music_search` (social-music-tools.ts) all run in the MCP child,
 * which may import neither `lib/social/service` nor `lib/jobs` — so every read
 * and write goes over the studio's own HTTP routes, through `api`.
 */
import { getCurrentPort } from "@/lib/libi-home";

/** The studio's loopback origin. Throws when the port is not known yet. */
export const studioBase = (): string => `http://127.0.0.1:${getCurrentPort()}`;

export type ApiResult<T> =
  | { ok: true; body: T }
  | { ok: false; status: number; body: { error?: string; message?: string } };

/**
 * One studio call. Never throws: an unreachable studio (or one whose port is
 * not known) comes back as `status: 0`, which every caller maps to
 * `libi_server_unavailable` rather than a tool crash the agent cannot act on.
 */
export async function api<T>(path: string, init?: RequestInit): Promise<ApiResult<T>> {
  let url: string;
  try {
    url = `${studioBase()}${path}`;
  } catch (err) {
    return { ok: false, status: 0, body: { message: err instanceof Error ? err.message : String(err) } };
  }
  try {
    const res = await fetch(url, {
      ...init,
      headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
      signal: AbortSignal.timeout(30_000),
    });
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    return res.ok
      ? { ok: true, body: body as T }
      : { ok: false, status: res.status, body: body as { error?: string; message?: string } };
  } catch (err) {
    return { ok: false, status: 0, body: { message: err instanceof Error ? err.message : String(err) } };
  }
}
