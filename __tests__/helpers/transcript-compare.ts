export interface RefWord {
  text: string;
  start: number;
  end: number;
}
export interface HypWord {
  text: string;
  start: number;
  end: number;
  type?: string;
  speaker_id?: string | null;
}

export function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokens(s: string): string[] {
  const n = normalize(s);
  return n.length === 0 ? [] : n.split(" ");
}

/** Levenshtein over word tokens, divided by reference length. */
export function wordErrorRate(hyp: string, ref: string): number {
  const h = tokens(hyp);
  const r = tokens(ref);
  if (r.length === 0) return h.length === 0 ? 0 : 1;
  const d: number[][] = Array.from({ length: h.length + 1 }, () =>
    new Array(r.length + 1).fill(0),
  );
  for (let i = 0; i <= h.length; i++) d[i][0] = i;
  for (let j = 0; j <= r.length; j++) d[0][j] = j;
  for (let i = 1; i <= h.length; i++) {
    for (let j = 1; j <= r.length; j++) {
      const cost = h[i - 1] === r[j - 1] ? 0 : 1;
      d[i][j] = Math.min(
        d[i - 1][j] + 1,
        d[i][j - 1] + 1,
        d[i - 1][j - 1] + cost,
      );
    }
  }
  return d[h.length][r.length] / r.length;
}

export function assertTranscriptShape(
  words: HypWord[],
  durationSeconds: number,
): void {
  if (words.length === 0) throw new Error("transcript has no words");
  let prevStart = -Infinity;
  for (const [i, w] of words.entries()) {
    if (typeof w.start !== "number" || typeof w.end !== "number")
      throw new Error(`word ${i} missing numeric start/end`);
    if (w.start > w.end)
      throw new Error(`word ${i} start ${w.start} > end ${w.end}`);
    if (w.start < 0) throw new Error(`word ${i} negative start ${w.start}`);
    if (w.end > durationSeconds + 0.5)
      throw new Error(
        `word ${i} end ${w.end} exceeds duration ${durationSeconds}`,
      );
    if (w.start < prevStart - 0.001)
      throw new Error(`word ${i} start ${w.start} not monotonic`);
    prevStart = w.start;
    if (w.type !== undefined && w.type !== "word")
      throw new Error(`word ${i} unexpected type ${w.type}`);
    if (w.speaker_id !== undefined && w.speaker_id !== null)
      throw new Error(`word ${i} unexpected speaker_id ${w.speaker_id}`);
  }
}

/** Aligns hyp↔ref by normalized word text (greedy LCS-ish) and checks the
 *  start-time delta distribution. Tolerance-based — engines never agree exactly. */
export function assertTimingAligned(
  hyp: HypWord[],
  ref: RefWord[],
  limits: { medianMs: number; p95Ms: number },
): void {
  const deltas: number[] = [];
  let ri = 0;
  for (const hw of hyp) {
    const ht = normalize(hw.text);
    for (let k = ri; k < ref.length; k++) {
      if (normalize(ref[k].text) === ht) {
        deltas.push(Math.abs(hw.start - ref[k].start) * 1000);
        ri = k + 1;
        break;
      }
    }
  }
  if (deltas.length < 3)
    throw new Error(
      `timing alignment matched too few words (${deltas.length})`,
    );
  deltas.sort((a, b) => a - b);
  const median = deltas[Math.floor(deltas.length / 2)];
  const p95 = deltas[Math.floor(deltas.length * 0.95)];
  if (median > limits.medianMs)
    throw new Error(`median start delta ${median}ms > ${limits.medianMs}ms`);
  if (p95 > limits.p95Ms)
    throw new Error(`p95 start delta ${p95}ms > ${limits.p95Ms}ms`);
}
