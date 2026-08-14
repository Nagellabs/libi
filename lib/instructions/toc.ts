export interface DocSectionLink {
  id: string;
  title: string;
  /** 1-based source line of the heading — lets renderers derive the same id
   *  purely from a heading's position (idempotent across re-renders). */
  line: number;
}

export function slugifyHeading(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-");
}

/** `##` headings (only) from a markdown doc, fence-aware, with stable ids.
 *  Drives both the side-nav TOC and the rendered heading anchors. */
export function extractSections(markdown: string): DocSectionLink[] {
  const out: DocSectionLink[] = [];
  const seen = new Map<string, number>();
  let inFence = false;
  const lines = markdown.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const m = /^##\s+(.+?)\s*$/.exec(line);
    if (!m) continue;
    const title = m[1].replace(/`/g, "");
    const base = slugifyHeading(title);
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    out.push({ id: n === 0 ? base : `${base}-${n}`, title, line: i + 1 });
  }
  return out;
}
