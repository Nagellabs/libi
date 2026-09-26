import { REMOTE_FETCH_MAX_URLS } from "@/lib/net/fetch-and-store";

export type FetchedUrl = { url: string; fileId?: string; error?: string };

/** Where one batch sits in the whole fetch: `offset` urls were handled by the
 *  batches before it, of `total`. A caller that forwards a job's progress adds
 *  `offset` and reports `total`, so the progress it shows only ever rises. */
export type BatchPosition = { offset: number; total: number };

/**
 * Download `urls` in consecutive batches of at most `size` — one `remote_fetch`
 * job caps its `urls` at {@link REMOTE_FETCH_MAX_URLS}, and a template may need
 * more (30 url assets + 12 https slots). Batches run one after another, so the
 * user sees one job at a time, and the results come back in `urls` order. Each
 * batch gets only the names of its own urls (none at all when no url in it is
 * named, exactly as a single call would).
 *
 * A url that fails comes back from its job as `{ url, error }` — one
 * unreachable host never throws. So a batch that THROWS failed as a whole: the
 * libi server is unreachable, the job failed, the user pressed Stop on it
 * (`CancelledError`), or the MCP client gave up (`AbortError`). Each of those
 * would hit every later batch too, and each is final, so it propagates at once
 * and no later batch starts: the apply fails exactly as the single job did
 * when there were 20 urls or fewer.
 */
export async function fetchInChunks(
  urls: string[],
  filenames: Record<string, string> | undefined,
  runOne: (urls: string[], filenames: Record<string, string> | undefined, position: BatchPosition) => Promise<FetchedUrl[]>,
  size: number = REMOTE_FETCH_MAX_URLS,
): Promise<FetchedUrl[]> {
  const total = urls.length;
  if (total <= size) return runOne(urls, filenames, { offset: 0, total });
  const out: FetchedUrl[] = [];
  for (let i = 0; i < total; i += size) {
    const chunk = urls.slice(i, i + size);
    const names = filenames ? pick(filenames, chunk) : undefined;
    out.push(...(await runOne(chunk, names, { offset: i, total })));
  }
  return out;
}

function pick(filenames: Record<string, string>, chunk: string[]): Record<string, string> | undefined {
  const names: Record<string, string> = {};
  for (const url of chunk) if (Object.prototype.hasOwnProperty.call(filenames, url)) names[url] = filenames[url];
  return Object.keys(names).length > 0 ? names : undefined;
}
