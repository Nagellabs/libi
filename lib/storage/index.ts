import type { FileStorage } from "./types";
import { LocalFileStorage } from "./local";
export type { FileStorage } from "./types";

let instance: FileStorage | undefined;
export async function getStorage(): Promise<FileStorage> {
  if (!instance) { instance = new LocalFileStorage(); }
  return instance;
}

export function resetStorage(): void {
  instance = undefined;
}
