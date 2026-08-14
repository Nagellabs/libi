export type SortOption = "created-desc" | "created-asc" | "a-z" | "z-a";

export const SORT_LABELS: Record<SortOption, string> = {
  "created-desc": "Newest first",
  "created-asc": "Oldest first",
  "a-z": "A \u2192 Z",
  "z-a": "Z \u2192 A",
};

export const ROOT_SORT_KEY = "libi:resources-sort-root";
export const INNER_SORT_KEY = "libi:resources-sort-inner";

export function loadSort(key: string): SortOption {
  try {
    const val = localStorage.getItem(key);
    if (val && val in SORT_LABELS) return val as SortOption;
  } catch { /* ignore */ }
  return "created-desc";
}

export function saveSort(key: string, value: SortOption): void {
  try { localStorage.setItem(key, value); } catch { /* ignore */ }
}

export function sortItems<T extends { name: string; createdAt: string | Date }>(
  items: T[],
  sort: SortOption,
): T[] {
  const sorted = [...items];
  switch (sort) {
    case "created-desc":
      return sorted.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    case "created-asc":
      return sorted.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
    case "a-z":
      return sorted.sort((a, b) => a.name.localeCompare(b.name));
    case "z-a":
      return sorted.sort((a, b) => b.name.localeCompare(a.name));
  }
}

export function getFileIcon(contentType: string | null): string {
  const ct = contentType ?? "";
  if (ct.startsWith("image/")) return "\uD83D\uDCF7";
  if (ct.startsWith("video/")) return "\uD83C\uDFA5";
  if (ct.startsWith("audio/")) return "\uD83C\uDFB5";
  if (ct === "application/pdf") return "\uD83D\uDCC4";
  return "\uD83D\uDCCE";
}
