/** Pure grid-layout helper for the storyboard Board view "Align" action. */

export interface GridItem {
  id: string;
  /** Scene order — items are laid out left→right, top→bottom by this. */
  order: number;
  width: number;
  height: number;
}

export interface GridLayoutOptions {
  /** Horizontal gap between columns (px). */
  colGap?: number;
  /** Vertical gap between rows (px). */
  rowGap?: number;
}

/**
 * Arrange items into a balanced grid and return absolute top-left positions
 * keyed by item id.
 *
 * Columns = `ceil(sqrt(n))`, so a set spreads over multiple lines as it grows
 * (4→2×2, 5→3×2, 6→3×2, 9→3×3). Items are sorted by `order` and placed in
 * reading order. Column x packs by the widest item in each column and row y by
 * the tallest item in the preceding row, so variable card heights never
 * overlap.
 */
export function gridLayout(
  items: GridItem[],
  opts: GridLayoutOptions = {},
): Record<string, { x: number; y: number }> {
  const colGap = opts.colGap ?? 60;
  const rowGap = opts.rowGap ?? 60;
  const positions: Record<string, { x: number; y: number }> = {};
  const n = items.length;
  if (n === 0) return positions;

  const cols = Math.max(1, Math.ceil(Math.sqrt(n)));
  const sorted = [...items].sort((a, b) => a.order - b.order);

  // Widest item per column index → column x offsets.
  const colWidth: number[] = [];
  sorted.forEach((it, i) => {
    const c = i % cols;
    colWidth[c] = Math.max(colWidth[c] ?? 0, it.width);
  });
  const colX: number[] = [];
  let x = 0;
  for (let c = 0; c < cols; c++) {
    colX[c] = x;
    x += (colWidth[c] ?? 0) + colGap;
  }

  // Pack rows top-down using the tallest item in each row.
  let y = 0;
  for (let r = 0; r * cols < n; r++) {
    const row = sorted.slice(r * cols, r * cols + cols);
    const rowHeight = Math.max(0, ...row.map((it) => it.height));
    row.forEach((it, c) => {
      positions[it.id] = { x: colX[c], y };
    });
    y += rowHeight + rowGap;
  }
  return positions;
}
