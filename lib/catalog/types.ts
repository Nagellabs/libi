import type { CharacterRecord, ItemRecord } from "@/lib/db/schema/types";

export type Character = CharacterRecord;
export type Item = ItemRecord;

export interface CatalogListOptions {
  query?: string;
  limit?: number;
  offset?: number;
}

export interface CreateCharacterInput {
  name: string;
  description?: string;
  representativeImageFileId?: string | null;
  nameSetByUser?: boolean;
}
export type CreateItemInput = CreateCharacterInput;

export interface UpdateCharacterInput {
  name?: string;
  description?: string;
  representativeImageFileId?: string | null;
  nameSetByUser?: boolean;
}
export type UpdateItemInput = UpdateCharacterInput;
