import { Logging } from "mediabunny";

/**
 * mediabunny's "Error parsing HEVC SPS" line, said once per file per session
 * and naming the file.
 *
 * mediabunny parses an HEVC stream's SPS for its colour space (1.55.4+) and,
 * in MPEG-TS or without an hvcC box, to build the decoder configuration. Its
 * parser throws on some real files (the Dreams TikTok original: "Invalid
 * exponential-Golomb code" in `skipStRefPicSet`, while ffprobe parses the same
 * SPS) and logs `console.error("Error parsing HEVC SPS:", err)` with no file
 * name, on every open, several times per open in MPEG-TS. In the packaged app
 * each one is a line of `electron-main-sync.log`, whose renderer budget is 500
 * lines per window (review M3).
 *
 * `attributeMediaLogs(fileKey, fn)` runs the part of a source's opening that
 * can trigger the parse (listing tracks and reading the decoder config)
 * inside an attribution region. Regions run one at a time, so a line logged
 * during one belongs to its file, whether the parse ran synchronously or
 * after an awaited packet read. Inside a region mediabunny's line is dropped,
 * and when the region ends the file gets one line, with the parser's error:
 * console.error in production (it reaches the packaged log once per file),
 * console.warn in dev (Next's dev overlay turns an error into a blocking
 * card). Outside a region nothing is filtered: a line libi can't attribute
 * reaches the console as mediabunny wrote it (review round 2, M4).
 *
 * Only the HEVC line is handled. "Error parsing AVC SPS" has not been seen,
 * and in 1.60 the AVC SPS also drives two Chromium decode workarounds
 * (interlaced content, B-frame loss), so a failure there stays a real error.
 */
const HEVC_SPS_LINE = "Error parsing HEVC SPS";

interface Region {
  fileKey: string;
  errors: string[];
}

let active: Region | null = null;
/** mediabunny just raised an HEVC SPS event inside a region: drop its console line. */
let dropNextLine = false;
const reported = new Set<string>();
let queue: Promise<unknown> = Promise.resolve();
let installed = false;

function install(): void {
  if (installed) return;
  installed = true;
  Logging.on("error", (args) => {
    if (!active || typeof args[0] !== "string" || !args[0].startsWith(HEVC_SPS_LINE)) return;
    const err = args[1] as { message?: unknown } | undefined;
    active.errors.push(typeof err?.message === "string" ? err.message : String(err));
    dropNextLine = true;
  });
  const previous = console.error;
  console.error = (...args: unknown[]) => {
    // mediabunny's Logging._error emits the event and then writes the line,
    // synchronously, so the flag covers exactly the line that raised it.
    if (dropNextLine && typeof args[0] === "string" && args[0].startsWith(HEVC_SPS_LINE)) {
      dropNextLine = false;
      return;
    }
    previous.apply(console, args as Parameters<Console["error"]>);
  };
}

/** A region that takes longer than this (a stalled read) stops holding the others up. */
const REGION_MAX_MS = 3000;

function endRegion(region: Region): void {
  if (active !== region) return;
  active = null;
  dropNextLine = false;
  if (region.errors.length > 0 && !reported.has(region.fileKey)) {
    reported.add(region.fileKey);
    const line =
      `[media] ${region.fileKey}: the HEVC header can't be parsed (${region.errors[0]}); ` +
      "mediabunny decodes without its colour information, or can't open the stream at all in MPEG-TS";
    if (process.env.NODE_ENV === "production") console.error(line);
    else console.warn(line);
  }
}

/** Run `fn` (track listing and decoder-config reads) with mediabunny's HEVC SPS lines attributed to `fileKey`. */
export function attributeMediaLogs<T>(fileKey: string, fn: () => Promise<T>): Promise<T> {
  install();
  let release!: () => void;
  const released = new Promise<void>((r) => { release = r; });
  const run = queue.then(async () => {
    const region: Region = { fileKey, errors: [] };
    active = region;
    const timer = setTimeout(() => { endRegion(region); release(); }, REGION_MAX_MS);
    try {
      return await fn();
    } finally {
      clearTimeout(timer);
      endRegion(region);
      release();
    }
  });
  queue = released;
  return run;
}

/** Test hook: forget what was reported. */
export function resetSpsDiagnosticsForTest(): void {
  reported.clear();
}
