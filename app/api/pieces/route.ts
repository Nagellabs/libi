import { getDb } from "@/lib/db/client";
import { pieces } from "@/lib/db/schema";
import { desc } from "drizzle-orm";
import { navigationEmitter } from "@/lib/navigation-events";
import { trackServerEvent } from "@/lib/analytics/server";

function formatPieceName(): string {
  const now = new Date();
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const isToday =
    now.getFullYear() === today.getFullYear() &&
    now.getMonth() === today.getMonth() &&
    now.getDate() === today.getDate();

  const timeStr = now.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });

  if (isToday) {
    return `Today, ${timeStr}`;
  }

  const dateStr = now.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
  return `${dateStr}, ${timeStr}`;
}

export async function GET() {
  const db = getDb();
  const allPieces = await db
    .select()
    .from(pieces)
    .orderBy(desc(pieces.updatedAt));

  return Response.json(allPieces);
}

export async function POST() {
  const db = getDb();

  const [piece] = await db
    .insert(pieces)
    .values({ name: formatPieceName() })
    .returning();

  void trackServerEvent("piece_created", { source: "ui" });

  navigationEmitter.emit("refresh_query", { queryKey: "pieces" });
  navigationEmitter.emit("refresh_query", { queryKey: "piece", pieceId: piece.id });

  return Response.json(piece, { status: 201 });
}
