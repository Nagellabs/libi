/**
 * Simple in-memory tracking of which piece is currently open in the editor.
 * Used by MCP tools (open piece) and the proxy LRU (open-piece protection)
 * without threading state through every call.
 */
const globalForEditor = globalThis as unknown as {
  __openedPieceId?: string | null;
};

export function getOpenedPieceId(): string | null {
  return globalForEditor.__openedPieceId ?? null;
}

export function setOpenedPieceId(pieceId: string | null): void {
  globalForEditor.__openedPieceId = pieceId;
}
