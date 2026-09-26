import { NextResponse } from "next/server";
import { z } from "zod/v3";
import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { pieces } from "@/lib/db/schema/sqlite";
import { getSocialSettings } from "@/lib/db/settings";
import { withAdapter } from "@/lib/social/service";
import { insertLink, touchLinkStatus } from "@/lib/social/links";
import { navigationEmitter } from "@/lib/navigation-events";
import { socialRoute, jsonBody } from "@/lib/social/route-helpers";

export const dynamic = "force-dynamic";

const linkBodySchema = z.object({
  pieceId: z.string().min(1),
  providerPostId: z.string().min(1),
  exportPath: z.string().optional(),
  createdBy: z.enum(["ui", "agent"]).default("agent"),
});

/**
 * `POST /api/social/links` — record one piece <-> provider-post link
 * directly (a caller that already knows both ids, e.g. the agent's own
 * posting tool). `?action=reindex` instead walks every page of the
 * provider's posts and rebuilds the whole table from each post's own
 * `metadata.libi.pieceId` stamp — the recovery path for links this table
 * never learned about (a post created outside `POST /api/social/posts`, or a
 * link row lost to a DB reset).
 */
export async function POST(req: Request): Promise<Response> {
  return socialRoute("links", async () => {
    const providerId = getSocialSettings().providerId;
    if (!providerId) return NextResponse.json({ error: "no_provider" }, { status: 409 });

    if (new URL(req.url).searchParams.get("action") === "reindex") {
      const existing = new Set(getDb().select({ id: pieces.id }).from(pieces).all().map((r) => r.id));
      let scanned = 0;
      let linked = 0;
      const orphans = new Set<string>();
      // A cap so one call cannot walk an unbounded history. When it bites, SAY so:
      // a silently half-finished reindex looks identical to a complete one, and the
      // caller's next move (run it again) depends on knowing the difference.
      const MAX_PAGES = 40;
      let truncated = false;
      await withAdapter(async (a) => {
        for (let page = 1, total = 1; page <= total; page++) {
          if (page > MAX_PAGES) {
            truncated = true;
            break;
          }
          const r = await a.listPosts({ page, limit: 100 });
          total = r.totalPages;
          for (const p of r.posts) {
            scanned++;
            const pid = p.libi?.pieceId;
            if (!pid) continue;
            if (!existing.has(pid)) {
              orphans.add(pid);
              continue;
            }
            insertLink({ providerId, providerPostId: p.id, pieceId: pid, exportPath: p.libi?.exportFile ?? null, requestId: null, createdBy: "agent" });
            touchLinkStatus(providerId, p.id, p.status);
            linked++;
          }
        }
      });
      navigationEmitter.emit("refresh_query", { queryKey: "social" });
      return NextResponse.json({ scanned, linked, orphans: [...orphans], truncated });
    }

    const b = await jsonBody(req, linkBodySchema);
    if (!b.ok) return b.res;
    if (!getDb().select({ id: pieces.id }).from(pieces).where(eq(pieces.id, b.data.pieceId)).get()) {
      return NextResponse.json({ error: "piece_not_found" }, { status: 404 });
    }
    insertLink({ providerId, providerPostId: b.data.providerPostId, pieceId: b.data.pieceId, exportPath: b.data.exportPath ?? null, requestId: null, createdBy: b.data.createdBy });
    navigationEmitter.emit("refresh_query", { queryKey: "social", pieceId: b.data.pieceId });
    return NextResponse.json({ ok: true });
  });
}
