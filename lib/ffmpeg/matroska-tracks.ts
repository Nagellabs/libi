/**
 * Which Matroska / WebM tracks the preview's demuxer (mediabunny) does not
 * list, so the server can leave them out of its primary-stream choice too.
 *
 * mediabunny drops a Matroska track that is disabled (FlagEnabled = 0), or
 * that carries a ContentEncoding other than block-scoped header stripping
 * (zlib/bzlib/lzo compression, encryption). ffprobe lists both. When such a
 * track was the first default one, the preview played one stream while the
 * proxy and the export mixed another (review M4). ffprobe exposes neither
 * property, so this reads the Tracks element itself.
 *
 * It reads only the start of the file and walks the Segment's top-level
 * elements until Tracks. A file whose Tracks can't be found that way (it sits
 * behind a Cluster, or beyond the read window) answers null, and the caller
 * keeps its old choice.
 */
import { open } from "fs/promises";

export interface MatroskaTrackFlags {
  /** TrackType: 1 video, 2 audio, 17 subtitle, ... */
  type: number;
  /** false when mediabunny drops the track. */
  listedByPreview: boolean;
  /** CodecDelay in seconds (an encoder delay: 1105 samples for LAME MP3, 1024
   *  for AAC, the pre-skip for Opus). ffmpeg subtracts it from the track's
   *  timestamps; mediabunny doesn't. 0 when absent. */
  codecDelay: number;
}

const ID_EBML = 0x1a45dfa3;
const ID_SEGMENT = 0x18538067;
const ID_TRACKS = 0x1654ae6b;
const ID_CLUSTER = 0x1f43b675;
const ID_TRACK_ENTRY = 0xae;
const ID_TRACK_TYPE = 0x83;
const ID_FLAG_ENABLED = 0xb9;
const ID_CODEC_DELAY = 0x56aa;
const ID_CONTENT_ENCODINGS = 0x6d80;
const ID_CONTENT_ENCODING = 0x6240;
const ID_CONTENT_ENCODING_SCOPE = 0x5032;
const ID_CONTENT_COMPRESSION = 0x5034;
const ID_CONTENT_COMP_ALGO = 0x4254;
const ID_CONTENT_ENCRYPTION = 0x5035;

/** Bytes read from the head of the file. Tracks normally sits in the first few KB. */
const READ_WINDOW = 1 << 20;

class Reader {
  constructor(
    private readonly b: Uint8Array,
    public pos = 0,
  ) {}
  get length(): number {
    return this.b.length;
  }
  /** An EBML element ID (marker bits kept), or null past the end. */
  id(): number | null {
    const first = this.b[this.pos];
    if (first === undefined) return null;
    let len = 1;
    while (len <= 4 && !(first & (0x80 >> (len - 1)))) len++;
    if (len > 4 || this.pos + len > this.b.length) return null;
    let v = 0;
    for (let i = 0; i < len; i++) v = v * 256 + this.b[this.pos + i];
    this.pos += len;
    return v;
  }
  /** An EBML data size (marker removed); Infinity for "unknown size". */
  size(): number | null {
    const first = this.b[this.pos];
    if (first === undefined) return null;
    let len = 1;
    while (len <= 8 && !(first & (0x80 >> (len - 1)))) len++;
    if (len > 8 || this.pos + len > this.b.length) return null;
    let v = first & (0xff >> len);
    let allOnes = v === 0xff >> len;
    for (let i = 1; i < len; i++) {
      const byte = this.b[this.pos + i];
      if (byte !== 0xff) allOnes = false;
      v = v * 256 + byte;
    }
    this.pos += len;
    return allOnes ? Infinity : v;
  }
  uint(size: number): number {
    let v = 0;
    for (let i = 0; i < size && this.pos + i < this.b.length; i++) v = v * 256 + this.b[this.pos + i];
    return v;
  }
}

/** Walk the children of [start, end), calling `onChild` with each element. */
function children(r: Reader, start: number, end: number, onChild: (id: number, dataStart: number, dataEnd: number) => boolean | void): boolean {
  r.pos = start;
  while (r.pos < end) {
    const id = r.id();
    const size = r.size();
    if (id === null || size === null) return false;
    const dataStart = r.pos;
    const dataEnd = size === Infinity ? end : Math.min(end, dataStart + size);
    if (onChild(id, dataStart, dataEnd) === false) return true;
    r.pos = dataEnd;
  }
  return true;
}

function parseTrackEntry(r: Reader, start: number, end: number): MatroskaTrackFlags {
  let type = 0;
  let enabled = true;
  let encodingsOk = true;
  let codecDelay = 0;
  children(r, start, end, (id, ds, de) => {
    if (id === ID_TRACK_TYPE) {
      r.pos = ds;
      type = r.uint(de - ds);
    } else if (id === ID_FLAG_ENABLED) {
      r.pos = ds;
      enabled = r.uint(de - ds) !== 0;
    } else if (id === ID_CODEC_DELAY) {
      r.pos = ds;
      codecDelay = r.uint(de - ds) / 1e9;
    } else if (id === ID_CONTENT_ENCODINGS) {
      const back = r.pos;
      children(r, ds, de, (eid, eds, ede) => {
        if (eid !== ID_CONTENT_ENCODING) return;
        // Exactly mediabunny's rule (matroska-demuxer.ts, 1.60): an encoding
        // becomes an instruction only when it carries ContentCompression
        // (algorithm default 0, zlib) or ContentEncryption, whichever comes
        // last; ContentEncodingType is not read. The track is dropped when an
        // instruction is anything but header stripping (3) at block scope (1).
        let scope = 1;
        let data: { kind: "decompress"; algo: number } | { kind: "decrypt" } | null = null;
        const inner = r.pos;
        children(r, eds, ede, (cid, cds, cde) => {
          if (cid === ID_CONTENT_ENCODING_SCOPE) { r.pos = cds; scope = r.uint(cde - cds); }
          else if (cid === ID_CONTENT_ENCRYPTION) data = { kind: "decrypt" };
          else if (cid === ID_CONTENT_COMPRESSION) {
            const compression = { kind: "decompress" as const, algo: 0 };
            data = compression;
            const inner2 = r.pos;
            children(r, cds, cde, (xid, xds, xde) => {
              if (xid === ID_CONTENT_COMP_ALGO) { r.pos = xds; compression.algo = r.uint(xde - xds); }
            });
            r.pos = inner2;
          }
        });
        r.pos = inner;
        const d = data as { kind: "decompress"; algo: number } | { kind: "decrypt" } | null;
        if (d && !(d.kind === "decompress" && d.algo === 3 && scope === 1)) encodingsOk = false;
      });
      r.pos = back;
    }
  });
  return { type, listedByPreview: enabled && encodingsOk, codecDelay };
}

/** Parse Matroska track flags from the head of a file's bytes. Exported for tests. */
export function parseMatroskaTrackFlags(bytes: Uint8Array): MatroskaTrackFlags[] | null {
  const r = new Reader(bytes);
  if (r.id() !== ID_EBML) return null;
  const ebmlSize = r.size();
  if (ebmlSize === null || ebmlSize === Infinity) return null;
  r.pos += ebmlSize;
  if (r.id() !== ID_SEGMENT) return null;
  const segSize = r.size();
  if (segSize === null) return null;
  const segStart = r.pos;
  const segEnd = segSize === Infinity ? bytes.length : Math.min(bytes.length, segStart + segSize);
  let tracks: MatroskaTrackFlags[] | null = null;
  children(r, segStart, segEnd, (id, ds, de) => {
    if (id === ID_CLUSTER) return false; // media before Tracks: give up
    if (id !== ID_TRACKS) return;
    const out: MatroskaTrackFlags[] = [];
    const back = r.pos;
    children(r, ds, de, (tid, tds, tde) => {
      if (tid === ID_TRACK_ENTRY) out.push(parseTrackEntry(r, tds, tde));
    });
    r.pos = back;
    tracks = out;
    return false;
  });
  return tracks;
}

/** Read the flags of a Matroska file's tracks; null when they can't be read. */
export async function readMatroskaTrackFlags(filePath: string): Promise<MatroskaTrackFlags[] | null> {
  let fh;
  try {
    fh = await open(filePath, "r");
    const buf = Buffer.alloc(READ_WINDOW);
    const { bytesRead } = await fh.read(buf, 0, READ_WINDOW, 0);
    return parseMatroskaTrackFlags(new Uint8Array(buf.buffer, buf.byteOffset, bytesRead));
  } catch {
    return null;
  } finally {
    await fh?.close();
  }
}

/**
 * ffprobe stream indexes of the tracks the preview doesn't list. Matroska
 * TrackEntries map to ffprobe streams in order, per type (ffmpeg creates one
 * stream per entry, in entry order; attachments, including cover art shown as
 * an attached_pic video stream, come after and are not entries).
 */
export function unlistedStreamIndexes(
  streams: Array<{ index?: number; codec_type?: string; disposition?: Record<string, number> }>,
  flags: MatroskaTrackFlags[],
): Set<number> {
  const out = new Set<number>();
  const byType = (t: number, codecType: string) => {
    const entries = flags.filter((f) => f.type === t);
    const probed = streams.filter((s) => s.codec_type === codecType && s.disposition?.attached_pic !== 1);
    if (entries.length !== probed.length) return; // can't map with confidence: filter nothing
    entries.forEach((e, i) => {
      const idx = probed[i].index;
      if (!e.listedByPreview && typeof idx === "number") out.add(idx);
    });
  };
  byType(1, "video");
  byType(2, "audio");
  return out;
}

/**
 * The CodecDelay (seconds) of the TrackEntry behind ffprobe stream
 * `streamIndex`, mapped per type in order as above; 0 when it has none or
 * can't be mapped.
 */
export function codecDelayOfStream(
  streams: Array<{ index?: number; codec_type?: string; disposition?: Record<string, number> }>,
  flags: MatroskaTrackFlags[],
  streamIndex: number,
): number {
  const s = streams.find((x) => x.index === streamIndex);
  const type = s?.codec_type === "audio" ? 2 : s?.codec_type === "video" ? 1 : 0;
  if (!s || type === 0) return 0;
  const entries = flags.filter((f) => f.type === type);
  const probed = streams.filter((x) => x.codec_type === s.codec_type && x.disposition?.attached_pic !== 1);
  if (entries.length !== probed.length) return 0;
  return entries[probed.indexOf(s)]?.codecDelay ?? 0;
}
