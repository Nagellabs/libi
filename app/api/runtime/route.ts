import { NextResponse } from "next/server";

/** Runtime metadata the UI needs to surface (dev-only banners, etc.).
 *
 *  Currently exposes:
 *    - `worktreeName`: when libi was launched from a `git worktree` checkout
 *      under `<project>/.claude/worktrees/<name>/`, `bin/libi.js` sets
 *      `process.env.LIBI_WORKTREE_NAME` so the sidebar can badge the brand
 *      ("libi · <worktree-name>"). Returns `null` for the canonical
 *      checkout or when launched outside a worktree.
 */
export async function GET(): Promise<Response> {
  const worktreeName = process.env.LIBI_WORKTREE_NAME?.trim() || null;
  return NextResponse.json({ worktreeName });
}
