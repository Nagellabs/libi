import { useQuery } from "@tanstack/react-query";

export type CatalogFieldError = "name" | "description";

export class CatalogError extends Error {
  readonly field?: CatalogFieldError;
  constructor(message: string, field?: CatalogFieldError) {
    super(message);
    this.name = "CatalogError";
    this.field = field;
  }
}

async function jsonFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, init);
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new CatalogError(body?.error ?? `Request failed (${r.status})`, body?.field);
  return body as T;
}

// ─── Characters ─────────────────────────────────────────────────────
export const characterKeys = {
  all: ["characters"] as const,
  forPiece: (pieceId: string) => ["pieces", pieceId, "characters"] as const,
};

export interface CharacterListItem {
  id: string;
  name: string;
  description: string;
  representativeImageFileId: string | null;
  representativeImageUrl: string | null;
}

export function usePieceCharacters(pieceId: string) {
  return useQuery({
    queryKey: characterKeys.forPiece(pieceId),
    queryFn: () => jsonFetch<{ groups: Array<{ file: { id: string; name: string; type: string }; characters: CharacterListItem[] }> }>(`/api/pieces/${pieceId}/characters`),
    enabled: !!pieceId,
  });
}

// ─── Items ─────────────────────────────────────────────────────────
export const itemKeys = {
  all: ["items"] as const,
  forPiece: (pieceId: string) => ["pieces", pieceId, "items"] as const,
};

export type ItemListItem = CharacterListItem;

export function usePieceItems(pieceId: string) {
  return useQuery({
    queryKey: itemKeys.forPiece(pieceId),
    queryFn: () => jsonFetch<{ groups: Array<{ file: { id: string; name: string; type: string }; items: ItemListItem[] }> }>(`/api/pieces/${pieceId}/items`),
    enabled: !!pieceId,
  });
}
