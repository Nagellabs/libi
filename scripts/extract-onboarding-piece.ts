// scripts/extract-onboarding-piece.ts
//
// Stage the media the real `libi-onboarding` piece references, so the first-run
// demo can be shipped as a hardcoded composition + a public bucket instead of
// two third-party CDN clips.
//
//   npm run onboarding:extract [-- --piece <pieceId>] [-- --rehash] [-- --force]
//
// STRICTLY READ-ONLY with respect to the source piece and the database. It
// opens the DB, SELECTs, copies bytes OUT, and writes only under
// `docs-local/onboarding-v1/` and `lib/onboarding/piece/v1/`. There is exactly
// one copy of this piece on this machine; nothing here may mutate it.
//
// What gets staged is decided by REFERENCE, never by directory listing: the
// piece's storage dir also holds three VO bus mixes, a superseded hero clip, a
// 6-second anthem, an unused `sfx-whoosh.mp3`, icon variants, a YouTube
// thumbnail, and every generated proxy and filmstrip. None of those render, so
// none of those ship.
//
// The staged bytes are not always the piece's bytes — the three fullscreen
// clips are published as CRF 20 re-encodes. So the default mode REFUSES to
// overwrite a staged file that differs from its source, and says which of the
// two other modes you meant:
//
//   --rehash  don't copy anything; re-pin `assets.ts` to whatever is staged.
//             The mode to use after deliberately replacing a staged file.
//   --force   genuinely replace the staged file with the piece's original,
//             discarding the re-encode.
//
// Without that guard, the documented command silently reverted the published
// set back to the originals and re-pinned `assets.ts` to them.
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { eq } from "drizzle-orm";
import { serverLogger as logger } from "@/lib/logger";
import { getDb } from "@/lib/db/client";
import { files as filesTable, pieces, tracks } from "@/lib/db/schema/sqlite";
import { getStorage } from "@/lib/storage";
import { loadManifest } from "@/lib/composition/persistence";
import type { CompositionManifest, PersistedOverlay } from "@/lib/composition/persistence";
import { stripRevealMirror } from "@/lib/overlays/hydrate";
import { readTrack } from "@/lib/tracking/storage";
import type { Track } from "@/lib/tracking/types";
import { resolveTrackedSpace, sampleTrackedOverlay } from "@/lib/engine/tracked-space";
import { prepareOverlayTracks } from "@/lib/tracking/prepare-overlay-tracks";
import { resolveTrackedRect } from "@/lib/engine/overlay-renderer";
import type { Overlay } from "@/lib/engine/types";
import { parseFontShorthand } from "@/lib/fonts/family";
import { GENERIC_CSS_FAMILIES } from "@/lib/fonts/resolve";
import {
  BUNDLED_FONT_FAMILIES,
  DEFAULT_MONO_FAMILY,
  DEFAULT_TEXT_FAMILY,
  isBundledFamily,
} from "@/lib/fonts/bundled";
import type { AssetKind, OnboardingAsset } from "@/lib/onboarding/piece/types";
import { endTimeMs, toMs } from "@/lib/onboarding/piece/types";

const TAG = "onboarding-extract";
const PIECE_NAME = "libi-onboarding";
/** The name a fresh install gives the demo piece. The source piece is called
 *  `libi-onboarding` — an internal working name nobody should see on first run. */
const DEFINITION_NAME = "Welcome to libi";
const OUT_DIR = path.join(process.cwd(), "docs-local", "onboarding-v1");
const ASSETS_DIR = path.join(OUT_DIR, "assets");
const V1_DIR = path.join(process.cwd(), "lib", "onboarding", "piece", "v1");
const GENERATED = path.join(V1_DIR, "assets.ts");

interface Args {
  pieceId?: string;
  rehash: boolean;
  force: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { rehash: false, force: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--piece") {
      const value = argv[i + 1];
      if (!value || value.startsWith("--")) throw new Error("--piece needs a piece id");
      args.pieceId = value;
      i++;
    } else if (argv[i] === "--rehash") {
      args.rehash = true;
    } else if (argv[i] === "--force") {
      args.force = true;
    } else {
      throw new Error(`unknown argument: ${argv[i]}`);
    }
  }
  if (args.rehash && args.force) {
    throw new Error("--rehash and --force are opposites: one keeps the staged bytes, the other replaces them");
  }
  return args;
}

/**
 * Resolve the piece to extract. Never guesses: the live piece and its backup
 * carry the same name often enough that picking "the first row" would silently
 * extract the wrong composition.
 */
function resolvePieceId(explicit: string | undefined): string {
  const db = getDb();
  if (explicit) {
    const row = db.select().from(pieces).where(eq(pieces.id, explicit)).all();
    if (row.length !== 1) throw new Error(`no piece with id ${explicit}`);
    return explicit;
  }
  const matches = db.select().from(pieces).where(eq(pieces.name, PIECE_NAME)).all();
  if (matches.length === 0) {
    throw new Error(`no piece named "${PIECE_NAME}" — pass --piece <id>`);
  }
  if (matches.length > 1) {
    const ids = matches.map((p) => p.id).join(", ");
    throw new Error(
      `${matches.length} pieces named "${PIECE_NAME}" (${ids}) — pass --piece <id> to choose`,
    );
  }
  return matches[0].id;
}

/**
 * Every fileId the composition actually renders: audio clips, image/video
 * overlays, the source video of any tracked overlay's track, and image/video
 * content mounted on a tracked overlay. Nothing else — a file in the storage
 * dir that nothing points at is a leftover, not an asset.
 */
function collectReferencedFileIds(pieceId: string, manifest: CompositionManifest): Set<string> {
  const db = getDb();
  const ids = new Set<string>();

  for (const clip of manifest.audioClips ?? []) {
    if (clip.fileId) ids.add(clip.fileId);
  }

  for (const overlay of manifest.overlays ?? []) {
    if ("fileId" in overlay && overlay.fileId) ids.add(overlay.fileId);
    if (overlay.kind === "tracked") {
      const content = overlay.content;
      if ((content.kind === "image" || content.kind === "video") && content.fileId) {
        ids.add(content.fileId);
      }
      // The track's own source video: a tracked overlay is meaningless without
      // the footage its samples were computed against.
      const track = db.select().from(tracks).where(eq(tracks.id, overlay.trackId)).all();
      if (track.length === 0) {
        throw new Error(`overlay ${overlay.id} references missing track ${overlay.trackId}`);
      }
      ids.add(track[0].fileId);
    }
  }

  logger.info(
    { tag: TAG, op: "collect", pieceId, fileCount: ids.size },
    "collected referenced fileIds",
  );
  return ids;
}

/**
 * Filename → bucket/local slug. Lowercased, with any run of characters outside
 * `[a-z0-9.-]` collapsed to a single `-` and leading/trailing `-` trimmed.
 *
 * A trailing ` (n)` duplicate marker is stripped FIRST, deliberately, and the
 * order matters — do not "simplify" this into the collapse rule alone.
 *
 * The marker is an upload artifact (`dedupeFilename` in mcp/tools/file-tools.ts
 * appends ` (N)` when a name is already taken in a piece), not part of the
 * asset's identity. Running only the
 * collapse rule would keep the digit — it is inside `[a-z0-9.-]` — and publish
 * the piece's `libi-ring-glyph (1).png` as `libi-ring-glyph-1.png`, baking a
 * meaningless upload accident into a public bucket path forever. Stripping the
 * marker first yields `libi-ring-glyph.png`, which is the asset's real name.
 *
 * The same storage dir does hold an unreferenced `libi-ring-glyph.png` twin,
 * byte-for-byte identical to the `(1)` variant — the piece happens to reference
 * the `(1)` one. Nothing references the twin, so it is never staged and the
 * clean slug is free. If a genuine collision ever does arise, the caller
 * asserts uniqueness across the staged set and fails loudly rather than
 * silently overwriting.
 *
 * Exported for `__tests__/unit/onboarding/slug-for-filename.test.ts` and for
 * nothing else — that file is what pins the ordering above.
 */
export function slugForFilename(filename: string): string {
  const ext = path.extname(filename).toLowerCase();
  const stem = path.basename(filename, path.extname(filename));
  const deduped = stem.replace(/\s*\(\d+\)\s*$/, "");
  const normalized = deduped
    .toLowerCase()
    .replace(/[^a-z0-9.-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!normalized) throw new Error(`filename produces an empty slug: ${filename}`);
  return `${normalized}${ext}`;
}

function assertKind(type: string, filename: string): AssetKind {
  if (type === "video" || type === "image" || type === "audio") return type;
  throw new Error(`unsupported file type "${type}" on ${filename}`);
}

function sha256OfFile(filePath: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

/** Byte-for-byte equality. Size first so the common "obviously different" case
 *  (a re-encode is a fifth of the original) never reads 60 MB to find out. */
function sameBytes(a: string, b: string): boolean {
  if (fs.statSync(a).size !== fs.statSync(b).size) return false;
  return sha256OfFile(a) === sha256OfFile(b);
}

interface StagedSet {
  assets: OnboardingAsset[];
  /** Slugs whose staged bytes differ from the piece's original — i.e. files
   *  deliberately replaced before publishing (the CRF 20 clip re-encodes).
   *  Empty when everything staged is the piece's own bytes. */
  restagedSlugs: string[];
  /** The one place a fileId is ever resolved. The definition emitter reads
   *  this and emits slugs; nothing downstream sees a fileId again. */
  slugByFileId: Map<string, string>;
}

interface PlannedAsset {
  fileId: string;
  kind: AssetKind;
  contentType: string;
  slug: string;
  src: string;
  dest: string;
  /** Something is staged at `dest` and its bytes differ from `src`. */
  restaged: boolean;
}

/**
 * Resolve every referenced file to a staging plan WITHOUT touching the assets
 * dir. Planning fully before copying anything is what makes the overwrite guard
 * meaningful: copy-as-you-go would have already reverted the clips that happen
 * to be iterated before the one that trips the guard, leaving the staged set
 * half-original and half-re-encode with a non-zero exit to explain it.
 */
async function planAssets(pieceId: string, fileIds: Set<string>, rehash: boolean): Promise<PlannedAsset[]> {
  const db = getDb();
  const storage = await getStorage();
  const bySlug = new Map<string, string>();
  const plan: PlannedAsset[] = [];

  for (const fileId of fileIds) {
    const rows = db.select().from(filesTable).where(eq(filesTable.id, fileId)).all();
    if (rows.length !== 1) throw new Error(`referenced fileId ${fileId} has no files row`);
    const file = rows[0];
    const kind = assertKind(file.type, file.filename);
    const slug = slugForFilename(file.filename);

    const previous = bySlug.get(slug);
    if (previous) {
      throw new Error(`slug collision on "${slug}": ${previous} and ${file.filename}`);
    }
    bySlug.set(slug, file.filename);

    if (!file.contentType) {
      // Every `files` row the piece references carries a content_type, but the
      // column is nullable, and a wrong Content-Type on a public bucket object
      // is a clip that will not play in Safari. Guessing from the extension
      // would paper over a real data problem — fail and go look at the row.
      throw new Error(`file ${file.filename} (${fileId}) has no content_type`);
    }

    // The ORIGINAL bytes, never `proxyFilename` — a proxy is a ≤1080p
    // scrub-friendly stand-in, and for an alpha-bearing source it would also
    // restore the background the piece removed. Resolved in BOTH modes: even
    // `--rehash` needs the source to tell a re-encode apart from an untouched
    // copy, which is what the generated header reports.
    const src = storage.localPath(pieceId, file.filename);
    if (!fs.existsSync(src)) throw new Error(`missing original on disk: ${src}`);

    const dest = path.join(ASSETS_DIR, slug);
    const staged = fs.existsSync(dest);
    if (rehash && !staged) throw new Error(`--rehash but nothing staged at ${dest}`);

    plan.push({
      fileId,
      kind,
      contentType: file.contentType,
      slug,
      src,
      dest,
      restaged: staged && !sameBytes(src, dest),
    });
  }

  return plan;
}

/**
 * Refuse to copy over any staged file whose bytes differ from its source.
 * Reports ALL of them at once — finding out about the second re-encode only
 * after deleting the first would be its own small disaster.
 */
function assertNoSilentRevert(plan: PlannedAsset[]): void {
  const conflicts = plan.filter((p) => p.restaged);
  if (conflicts.length === 0) return;
  const detail = conflicts
    .map((p) => `${p.slug} (staged ${fs.statSync(p.dest).size} B vs original ${fs.statSync(p.src).size} B)`)
    .join(", ");
  throw new Error(
    `${conflicts.length} staged file(s) differ from the piece's original: ${detail}. ` +
      `Copying would discard those bytes and re-pin assets.ts to the originals. Re-run with ` +
      `--rehash to re-pin assets.ts to what is staged, or with --force to genuinely replace ` +
      `them with the piece's originals.`,
  );
}

async function stageAssets(pieceId: string, fileIds: Set<string>, args: Args): Promise<StagedSet> {
  fs.mkdirSync(ASSETS_DIR, { recursive: true });
  const plan = await planAssets(pieceId, fileIds, args.rehash);
  if (!args.rehash && !args.force) assertNoSilentRevert(plan);

  const assets: OnboardingAsset[] = [];
  const restagedSlugs: string[] = [];
  const slugByFileId = new Map<string, string>();

  for (const p of plan) {
    slugByFileId.set(p.fileId, p.slug);
    let restaged = p.restaged;
    if (!args.rehash) {
      if (restaged) {
        logger.warn(
          { tag: TAG, op: "force-replace", slug: p.slug },
          "--force: replacing staged bytes with the piece's original",
        );
      }
      fs.copyFileSync(p.src, p.dest);
      restaged = false;
    }
    if (restaged) restagedSlugs.push(p.slug);

    // Hash and size come from the STAGED copy, so they always describe the
    // exact bytes that get uploaded — including after a deliberate re-encode.
    const stat = fs.statSync(p.dest);
    assets.push({
      slug: p.slug,
      kind: p.kind,
      bytes: stat.size,
      sha256: sha256OfFile(p.dest),
      contentType: p.contentType,
    });

    logger.info(
      { tag: TAG, op: "stage", slug: p.slug, kind: p.kind, bytes: stat.size, copied: !args.rehash, restaged },
      "staged asset",
    );
  }

  // Plain `<`, never `localeCompare`: this order is baked into a COMMITTED
  // generated file, and ICU collation differs between machines and Node builds.
  // A locale-dependent sort would churn the diff of the one file whose entire
  // job is to be stable. (`toLocaleString("en-US")` in the header is pinned and
  // is fine.)
  assets.sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
  restagedSlugs.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return { assets, restagedSlugs, slugByFileId };
}

/**
 * Fail on anything in the assets dir that is not in the current staged set.
 *
 * FAIL rather than prune, deliberately. An orphan is almost always a rename in
 * flight or a re-encode staged under the wrong name — bytes someone produced by
 * hand, which this script did not create and has no business deleting. That is
 * the same reasoning as the overwrite guard above: `rm` is one command away,
 * re-rendering a lost re-encode is not. What matters is that it cannot stay
 * INVISIBLE — absent from manifest.json but still there for anything that globs
 * the directory, the publish script included.
 */
function assertNoOrphans(assets: OnboardingAsset[]): void {
  const expected = new Set(assets.map((a) => a.slug));
  const orphans = fs
    .readdirSync(ASSETS_DIR)
    .filter((name) => !expected.has(name))
    .sort();
  if (orphans.length === 0) return;
  throw new Error(
    `${orphans.length} file(s) in ${ASSETS_DIR} are not referenced by the piece: ${orphans.join(", ")}. ` +
      `Anything that globs that directory would publish them. Delete them (macOS .DS_Store included) and re-run.`,
  );
}

function writeManifest(assets: OnboardingAsset[]): void {
  const target = path.join(OUT_DIR, "manifest.json");
  fs.writeFileSync(target, `${JSON.stringify({ version: 1, assets }, null, 2)}\n`, "utf-8");
  logger.info({ tag: TAG, op: "manifest", path: target, count: assets.length }, "wrote manifest");
}

/**
 * The provenance paragraph, DERIVED from what is actually staged rather than
 * asserted. A hardcoded "the clips are a re-encode" line would still be there
 * after a run that replaced the re-encodes with the originals, so the generated
 * file would claim something the run did not produce.
 */
function provenanceLines(restagedSlugs: string[]): string[] {
  if (restagedSlugs.length === 0) {
    return [
      `// The piece decides WHICH files ship; it does not decide their bytes. Every`,
      `// record below describes the STAGED file — and right now every staged file is`,
      `// byte-identical to the piece's original. Nothing here is a re-encode.`,
    ];
  }
  return [
    `// The piece decides WHICH files ship; it does not decide their bytes.`,
    `// ${restagedSlugs.length} of these records describe a STAGED file that differs from the piece's`,
    `// original — deliberately replaced before publishing, see`,
    `// docs-local/onboarding-v1/reencode-decision.md:`,
    ...restagedSlugs.map((slug) => `//   ${slug}`),
    `// Every other record is the piece's original bytes, byte for byte.`,
  ];
}

function writeGenerated(assets: OnboardingAsset[], restagedSlugs: string[]): void {
  const total = assets.reduce((n, a) => n + a.bytes, 0);
  const body = assets
    .map(
      (a) =>
        `  {\n` +
        `    slug: ${JSON.stringify(a.slug)},\n` +
        `    kind: ${JSON.stringify(a.kind)},\n` +
        `    bytes: ${a.bytes},\n` +
        `    sha256: ${JSON.stringify(a.sha256)},\n` +
        `    contentType: ${JSON.stringify(a.contentType)},\n` +
        `  },`,
    )
    .join("\n");

  const source =
    `// GENERATED FILE — do not edit by hand.\n` +
    `// Written by scripts/extract-onboarding-piece.ts (npm run onboarding:extract)\n` +
    `// from the media the real \`libi-onboarding\` piece references.\n` +
    `//\n` +
    `// ${assets.length} assets, ${total.toLocaleString("en-US")} bytes total. Each sha256 pins the exact\n` +
    `// bytes published to the bucket: a download that does not hash to this is not\n` +
    `// the demo we shipped, and the build must fail rather than render it.\n` +
    `//\n` +
    `${provenanceLines(restagedSlugs).join("\n")}\n` +
    `import type { OnboardingAsset } from "../types";\n` +
    `\n` +
    `export const ONBOARDING_ASSETS_V1: readonly OnboardingAsset[] = [\n` +
    `${body}\n` +
    `];\n` +
    `\n` +
    `const BY_SLUG = new Map<string, OnboardingAsset>(\n` +
    `  ONBOARDING_ASSETS_V1.map((a) => [a.slug, a]),\n` +
    `);\n` +
    `\n` +
    `/** Look up one asset by its stable slug. Undefined for anything not published. */\n` +
    `export function assetBySlug(slug: string): OnboardingAsset | undefined {\n` +
    `  return BY_SLUG.get(slug);\n` +
    `}\n`;

  fs.mkdirSync(path.dirname(GENERATED), { recursive: true });
  fs.writeFileSync(GENERATED, source, "utf-8");
  logger.info(
    { tag: TAG, op: "generate", path: GENERATED, count: assets.length, total, restaged: restagedSlugs },
    "wrote assets.ts",
  );
}

/* ================================================================== *
 * The composition definition
 *
 * Everything above stages BYTES. Everything below emits the FILM: the
 * scenes, overlays and audio clips that arrange those bytes into 52 seconds,
 * with every machine-local `fileId` resolved to its slug. The piece's object
 * track is READ here (slot D's reticle is baked from it) but never emitted —
 * see the "Slot D" section.
 * ================================================================== */

/** A literal TypeScript expression to splice in verbatim — how a draw
 *  function becomes `SLOT_A_DRAW` instead of a 4 KB inline string. */
class TsExpr {
  constructor(readonly source: string) {}
}
function expr(source: string): TsExpr {
  return new TsExpr(source);
}

/** `code-t9hx2cb7` → `CODE_T9HX2CB7`. */
function identFromId(id: string): string {
  const ident = id.toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  if (!/^[A-Z_][A-Z0-9_]*$/.test(ident)) throw new Error(`id produces no identifier: ${id}`);
  return ident;
}

/**
 * Wrap `text` in a template literal whose VALUE is byte-for-byte the source.
 *
 * Only two sequences need escaping — a backtick and `${` — which is exactly
 * the guarantee the emitted files claim. Any backslash would need a third
 * escape and `String.raw` would be the tool for it, but `String.raw` cannot
 * express a literal backtick at all (its raw text keeps the backslash), so a
 * backslash-bearing draw function has no correct spelling here. It throws
 * rather than emitting something that reads right and renders differently.
 */
function templateLiteral(text: string): string {
  if (text.includes("\\")) {
    throw new Error(
      "draw source contains a backslash: a template literal would eat it and " +
        "String.raw cannot escape the backticks this source also has. Teach the " +
        "emitter a real escaper before shipping it.",
    );
  }
  const escaped = text.replace(/`/g, "\\`").replace(/\$\{/g, "\\${");
  // Cheap proof the escape round-trips, so a future edit to the two rules
  // above cannot silently corrupt a draw function.
  const roundTrip = escaped.replace(/\\`/g, "`").replace(/\\\$\{/g, "${");
  if (roundTrip !== text) throw new Error("template escape does not round-trip");
  return `\`${escaped}\``;
}

/** True when the object is small and flat enough to read on one line. */
function isFlatLeaf(value: Record<string, unknown> | unknown[]): boolean {
  const values = Array.isArray(value) ? value : Object.values(value);
  return values.every((v) => v === null || typeof v !== "object");
}

const IDENT_KEY = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/**
 * Serialize a plain JSON value as readable TypeScript.
 *
 * Numbers go through `String`, which is JavaScript's shortest round-tripping
 * representation — no rounding, no fixed precision. That matters twice over
 * here: the track's box coordinates are sub-pixel, and every end-card overlay
 * carries keyframe `t` values that were rescaled when the card was extended
 * from 1.4 s to 11.4 s. They look arbitrary because they ARE the output of a
 * rescale; tidying them retimes the animation.
 */
function serializeTs(value: unknown, indent: string): string {
  if (value instanceof TsExpr) return value.source;
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  const next = `${indent}  `;

  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    const parts = value.map((v) => serializeTs(v, next));
    if (isFlatLeaf(value) && parts.join(", ").length <= 96) return `[${parts.join(", ")}]`;
    return `[\n${parts.map((p) => `${next}${p}`).join(",\n")},\n${indent}]`;
  }

  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).filter(
      ([, v]) => v !== undefined,
    );
    if (entries.length === 0) return "{}";
    const parts = entries.map(
      ([k, v]) => `${IDENT_KEY.test(k) ? k : JSON.stringify(k)}: ${serializeTs(v, next)}`,
    );
    if (isFlatLeaf(value as Record<string, unknown>) && parts.join(", ").length <= 96) {
      return `{ ${parts.join(", ")} }`;
    }
    return `{\n${parts.map((p) => `${next}${p}`).join(",\n")},\n${indent}}`;
  }

  throw new Error(`cannot serialize ${typeof value}`);
}

/** One draw body as it will be emitted, plus whatever the emitter changed. */
interface EmittedBody {
  source: string;
  substitutions: FontSubstitution[];
  corrections: TextCorrection[];
}

/** One font family the source named that libi does not bundle. */
interface FontSubstitution {
  /** Overlay id, or the scene/overlay whose DRAW CODE names it. */
  owner: string;
  field: string;
  from: string;
  to: string;
}

const MONOSPACE_HINTS = [
  "mono",
  "menlo",
  "consolas",
  "courier",
  "typewriter",
  "terminal",
  "code",
];

function wantsMonospace(family: string): boolean {
  const needle = family.toLowerCase();
  return MONOSPACE_HINTS.some((hint) => needle.includes(hint));
}

/**
 * Any family libi does not bundle maps to one it does — monospace requests to
 * `JetBrains Mono`, everything else to `Inter`.
 *
 * A family libi DOES bundle is returned under the registry's own spelling
 * rather than re-derived from the monospace hints. That distinction only bites
 * when the bundle grows: a third family (a display face, say) would otherwise
 * be silently flattened to Inter by the fallback below.
 */
function bundledFamilyFor(family: string): string {
  const needle = family.trim().toLowerCase();
  const known = BUNDLED_FONT_FAMILIES.find((f) => f.toLowerCase() === needle);
  if (known) return known;
  return wantsMonospace(family) ? DEFAULT_MONO_FAMILY : DEFAULT_TEXT_FAMILY;
}

/**
 * Rewrite one `font` / `fontFamily` value so it names a bundled family.
 *
 * `font` is a CSS shorthand (`"48px Inter"`, `"700 42px Menlo, monospace"`) —
 * the size/weight prefix is kept exactly and only the family list is replaced.
 * `fontFamily` is a bare family name. Returns the input unchanged when it
 * already resolves.
 */
function mapFontValue(field: string, value: string, owner: string, out: FontSubstitution[]): string {
  const shorthand = field === "font" ? parseFontShorthand(value) : null;
  const requested = (shorthand ? shorthand.family.split(",")[0] : value).trim();
  if (!requested) return value;
  const family = bundledFamilyFor(requested);
  const mapped = shorthand ? `${shorthand.prefix} ${family}` : family;
  if (mapped === value) return value;
  out.push({ owner, field, from: value, to: mapped });
  return mapped;
}

interface DefinitionContext {
  slugByFileId: Map<string, string>;
  substitutions: FontSubstitution[];
}

/**
 * Recursively rewrite one manifest node into its definition form: every
 * `fileId` becomes an `assetSlug`, every font family becomes a bundled one,
 * and everything else is copied through untouched.
 */
function toDefinitionValue(node: unknown, owner: string, ctx: DefinitionContext): unknown {
  if (Array.isArray(node)) return node.map((v) => toDefinitionValue(v, owner, ctx));
  if (node === null || typeof node !== "object") return node;

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (key === "fileId") {
      if (typeof value !== "string") throw new Error(`${owner}: fileId is not a string`);
      const slug = ctx.slugByFileId.get(value);
      if (!slug) throw new Error(`${owner}: fileId ${value} was never staged`);
      out.assetSlug = slug;
      continue;
    }
    if ((key === "font" || key === "fontFamily") && typeof value === "string") {
      out[key] = mapFontValue(key, value, owner, ctx.substitutions);
      continue;
    }
    out[key] = toDefinitionValue(value, owner, ctx);
  }
  return out;
}

/**
 * Complete `ctx.font` strings the piece's draw code sets, mapped to what libi
 * actually ships. Keyed by the WHOLE string, never by a pattern over the
 * family token.
 *
 * This rewrites JavaScript source, and a pattern loose enough to catch a
 * family name is also loose enough to catch a comment, a variable, or half a
 * template literal — and the failure mode is a draw function that no longer
 * parses, which surfaces as a blank frame nobody looks at. An exact-literal
 * map cannot do that: a string either matches in full or is left alone, and
 * `assertCodeFontsCovered` fails the extraction on anything left alone that
 * should not have been.
 *
 * WHY THIS DIVERGES FROM THE PIECE: `Menlo` is macOS-only. Every one of these
 * assignments falls through to generic `monospace` on Windows and Linux, so a
 * new user there would watch the film render in a face nobody chose — the
 * exact bug `lib/fonts/bundled.ts` exists to prevent, which Plan 1 already
 * fixed for overlay text. `58px sans-serif` is worse still: a bare generic
 * with no family in front of it at all.
 *
 * NOTE THE INNER QUOTES. `JetBrains Mono` contains a space, so a CSS font
 * shorthand must quote it — `500 22px JetBrains Mono, monospace` does not
 * parse and the canvas silently ignores the whole assignment. The emitter
 * re-delimits the surrounding JS string literal (to single quotes) so those
 * inner double quotes need no backslash, which keeps every body free of
 * escapes — see `templateLiteral`.
 *
 * `Inter, sans-serif` is deliberately absent: Inter is bundled and a generic
 * keyword BEHIND a real family is a legitimate last-resort fallback.
 */
const CODE_FONT_REPLACEMENTS: Readonly<Record<string, string>> = {
  "400 32px Menlo, monospace": `400 32px "JetBrains Mono", monospace`,
  "500 19px Menlo, monospace": `500 19px "JetBrains Mono", monospace`,
  "500 20px Menlo, monospace": `500 20px "JetBrains Mono", monospace`,
  "500 21px Menlo, monospace": `500 21px "JetBrains Mono", monospace`,
  "500 22px Menlo, monospace": `500 22px "JetBrains Mono", monospace`,
  "500 30px Menlo, monospace": `500 30px "JetBrains Mono", monospace`,
  "600 30px Menlo, monospace": `600 30px "JetBrains Mono", monospace`,
  "58px sans-serif": "58px Inter, sans-serif",
};

/**
 * EVERY string literal in a draw body, capturing the delimiter so it can be
 * reissued.
 *
 * Deliberately not `\.font\s*=` — that was the first version of this and it
 * missed one. `scene_x1t3l2xt` does not assign `ctx.font` at all for its chat
 * text; it passes the font as an object property to a helper:
 *
 *     drawTextBlock(ctx, typed, x, y, w, 46, { font: "400 32px Menlo, monospace", … })
 *
 * A rule keyed on how a font is USED will always be one call shape behind the
 * code it inspects. Sweeping every literal and deciding by what the string IS
 * cannot miss that way.
 *
 * Written as an alternation per quote style, NOT as `(["'`])([^"'`]*)\1`.
 * The naive form cannot match a literal that contains a different quote —
 * `'500 22px "JetBrains Mono", monospace'` is exactly that shape, so a second
 * pass over already-substituted output would slice it wrong and see the fonts
 * it just wrote as unparseable fragments.
 *
 * Precondition: the body contains no backslashes (asserted below), so this
 * needs no escape handling.
 */
const STRING_LITERAL = /"([^"]*)"|'([^']*)'|`([^`]*)`/g;

/**
 * A parsed shorthand counts as a FONT only when its first family reads like a
 * family name. Other CSS values share the shape — `"0 0 12px rgba(0,0,0,.5)"`
 * parses as prefix `0 0 12px` + family `rgba(0,0,0,.5)` — and rewriting a drop
 * shadow as a font would be a spectacular own goal. Nothing with a paren, a
 * hash or a digit-leading first token gets through.
 */
const FAMILY_NAME = /^[A-Za-z][A-Za-z0-9 _-]*$/;

/** Split a font shorthand's family list into bare, unquoted family names. */
function familyList(font: string): string[] {
  const parsed = parseFontShorthand(font);
  if (!parsed) return [];
  return parsed.family
    .split(",")
    .map((f) => f.trim().replace(/^["']|["']$/g, ""))
    .filter(Boolean);
}

/** True when a font string already names a bundled family FIRST. Anything
 *  behind it may be a generic keyword or another bundled family — a generic
 *  is a legitimate last-resort fallback, but never the first entry. */
function fontIsBundled(font: string): boolean {
  const families = familyList(font);
  if (families.length === 0) return false;
  if (!isBundledFamily(families[0])) return false;
  return families
    .slice(1)
    .every((f) => isBundledFamily(f) || GENERIC_CSS_FAMILIES.has(f.toLowerCase()));
}

/** True when a string literal is a CSS font shorthand rather than some other
 *  px-bearing CSS value that happens to parse like one. */
function looksLikeFont(value: string): boolean {
  const families = familyList(value);
  return families.length > 0 && FAMILY_NAME.test(families[0]);
}

/**
 * A template literal's text with every `${…}` replaced by a digit, so a
 * DYNAMIC font is still recognisable as a font.
 *
 * Without this, `` `500 ${n}px Menlo` `` has no literal `<n>px` token, fails
 * `parseFontShorthand`, and sails through untouched — a macOS-only family
 * shipping precisely because it was computed rather than written out. With it,
 * the probe reads `500 0px Menlo`, which parses, so the family is checked like
 * any other and an unbundled one aborts the extraction.
 *
 * Legitimate dynamic fonts still pass: `` `500 ${n}px Inter, sans-serif` ``
 * probes as bundled and is left alone. Non-fonts stay non-fonts —
 * `` `translate(${x}px, ${y}px)` `` probes to a family of `0px)`, which
 * `FAMILY_NAME` rejects.
 *
 * `[^}]*` does not nest, so an interpolation containing `}` degrades to "does
 * not parse" — i.e. to the old behaviour, never to a wrong rewrite.
 */
function fontProbe(value: string): string {
  return value.replace(/\$\{[^}]*\}/g, "0");
}

/** Wrap a replacement font string in a JS string literal that needs no
 *  backslash — the whole reason the emitted bodies stay escape-free. */
function jsStringLiteral(value: string, original: string): string {
  if (!value.includes(`"`)) return `"${value}"`;
  if (!value.includes(`'`)) return `'${value}'`;
  throw new Error(`replacement font ${JSON.stringify(value)} needs escaping (from ${original})`);
}

/**
 * Rewrite every font string in one draw body so it names a bundled family, and
 * FAIL THE EXTRACTION on any the map does not cover.
 *
 * The throw is the point. The first version of this only logged, and a log
 * line nobody greps for is the same as no line at all — `Menlo` shipped
 * anyway. A substitution only ever happens on an exact full-string match, so
 * the failure mode here is a loud stop, never a mangled draw function.
 */
function bundleFontsInCode(owner: string, source: string): EmittedBody {
  if (source.includes("\\")) {
    throw new Error(`${owner}: draw code contains a backslash — STRING_LITERAL cannot slice it`);
  }
  const substitutions: FontSubstitution[] = [];
  const rewritten = source.replace(
    STRING_LITERAL,
    (whole, dq?: string, sq?: string, tq?: string) => {
      const value = dq ?? sq ?? tq ?? "";
      // Decide on the PROBE (interpolations neutralised) but substitute on the
      // exact literal — so a dynamic unbundled font is recognised, finds no
      // map entry, and stops the build rather than being rewritten blind.
      const probe = fontProbe(value);
      if (!looksLikeFont(probe) || fontIsBundled(probe)) return whole;
      const replacement = CODE_FONT_REPLACEMENTS[value];
      if (!replacement) {
        throw new Error(
          `${owner}: draw code names an unbundled font ${JSON.stringify(value)} that ` +
            `CODE_FONT_REPLACEMENTS does not cover. Add the complete string to the map ` +
            `(or, if the family is dynamic, make it static — an interpolated family cannot ` +
            `be mapped by exact literal) — it must not ship as a silent platform fallback. ` +
            `If this string is not a font at all, tighten FAMILY_NAME.`,
        );
      }
      if (!fontIsBundled(replacement)) {
        throw new Error(`${owner}: replacement ${JSON.stringify(replacement)} is not bundled`);
      }
      substitutions.push({ owner, field: "draw-code", from: value, to: replacement });
      return jsStringLiteral(replacement, value);
    },
  );
  return { source: rewritten, substitutions, corrections: [] };
}

/** One on-screen string the emitter rewrites because the piece's version of it
 *  states something untrue about libi. */
interface TextCorrection {
  owner: string;
  from: string;
  to: string;
  why: string;
}

/**
 * SET-DRESSING CORRECTIONS — the second deliberate divergence from the source
 * piece, after the font map, and it exists for the same reason: the source
 * piece is the user's work product and stays untouched, so a string that is
 * wrong ON SCREEN has to be fixed on the way out.
 *
 * These are LITERALS INCLUDING THEIR QUOTES, matched exactly and required to
 * appear exactly once in the named owner's draw body. A silent no-op would be
 * the whole failure mode: the correction would stop applying the moment the
 * piece is edited, and nothing would say so.
 */
const TEXT_CORRECTIONS: TextCorrection[] = [
  {
    // Slot D's telemetry strip is mock UI — the confidence readout and frame
    // counter are animated set dressing, which is fine and matches every other
    // slot. But this chip names a REAL libi `TrackMethod`, and it named the
    // wrong one: the track those reticle boxes were computed from carries
    // `method: "yoloe+botsort"`. `sot` is a different tracker entirely.
    // Splitting rather than repeating: `yoloe+botsort` is a detector plus a
    // tracker, so naming the whole pipeline in BOTH chips renders as
    // "engine yoloe+botsort | method yoloe+botsort" — true but redundant, and
    // it wastes the one chip that could say something. YOLOE detects, BoTSORT
    // associates detections across frames; splitting them keeps both chips
    // accurate and makes the strip read like real telemetry.
    owner: "code-558ob5uw",
    from: '"method sot"',
    to: '"method botsort"',
    why: "sot is a different tracker; botsort is what actually associated these boxes",
  },
  {
    owner: "code-558ob5uw",
    from: '"engine yoloe+botsort"',
    to: '"engine yoloe"',
    why: "pairs with the method chip above — yoloe detects, botsort tracks",
  },
];

/** Apply every correction registered for `owner`, insisting each one lands. */
function applyTextCorrections(owner: string, code: string): EmittedBody {
  const corrections = TEXT_CORRECTIONS.filter((c) => c.owner === owner);
  let source = code;
  for (const c of corrections) {
    const hits = source.split(c.from).length - 1;
    if (hits !== 1) {
      throw new Error(
        `${owner}: text correction ${c.from} -> ${c.to} matched ${hits} times, expected 1. ` +
          `The piece's draw code changed under it; re-read the code and update ` +
          `TEXT_CORRECTIONS rather than letting a wrong string ship.`,
      );
    }
    source = source.replace(c.from, c.to);
  }
  return { source, substitutions: [], corrections };
}

/** One draw body, corrected and font-bundled — the whole emit pipeline for a
 *  scene or overlay body, in the order the two passes have to run (corrections
 *  first: the font pass rewrites string literals and would then have to be
 *  matched against its own output). */
function emitBody(owner: string, code: string): EmittedBody {
  const corrected = applyTextCorrections(owner, code);
  const bundled = bundleFontsInCode(owner, corrected.source);
  return {
    source: bundled.source,
    substitutions: bundled.substitutions,
    corrections: corrected.corrections,
  };
}

function generatedHeader(lines: string[]): string {
  return [
    "// GENERATED FILE — do not edit by hand.",
    "// Written by scripts/extract-onboarding-piece.ts (npm run onboarding:extract)",
    ...lines,
    "",
  ].join("\n");
}

/**
 * The fidelity paragraph for one emitted draw body, DERIVED from the
 * substitutions that body actually received.
 *
 * A fixed "byte-for-byte" line would keep claiming that after the emitter
 * started rewriting fonts, which is precisely the kind of comment that sends
 * the next reader off to "fix" a deliberate change back.
 */
function fidelityLines(body: EmittedBody): string[] {
  const { substitutions: subs, corrections } = body;
  const lines: string[] = [];
  if (subs.length === 0) {
    lines.push(
      "// Byte-for-byte the body stored in the piece. Only a backtick and a",
      "// `${` are escaped — nothing else is reformatted, because this string is",
      "// compiled and run, not read.",
    );
  } else {
    lines.push(
      "// Byte-for-byte the body stored in the piece EXCEPT for the",
      `// ${subs.length} font string(s) listed below — whether set via \`ctx.font\` or passed`,
      `// to a helper as \`{ font: … }\`. Only a backtick and a \`${"$"}{\` are escaped`,
      "// otherwise.",
      "//",
      "// THIS IS A DELIBERATE DIVERGENCE FROM THE SOURCE PIECE — do not diff the",
      "// two and 'fix' it back. The piece names macOS-only families that fall",
      "// through to a platform default on Windows and Linux; libi bundles Inter",
      "// and JetBrains Mono so the film renders identically everywhere. The",
      "// source piece is the user's work product and stays untouched, so the",
      "// substitution lives here, in the emitter's map.",
      "//",
      ...subs.map((s) => `//   ${JSON.stringify(s.from)} -> ${JSON.stringify(s.to)}`),
    );
  }
  if (corrections.length > 0) {
    lines.push(
      "//",
      `// ${corrections.length} ON-SCREEN STRING(S) ALSO DIVERGE, for a different reason —`,
      "// the piece shows them to the user and they say something untrue about",
      "// libi. Registered in the emitter's TEXT_CORRECTIONS with the reason:",
      "//",
      ...corrections.map((c) => `//   ${c.from} -> ${c.to}  (${c.why})`),
    );
  }
  return lines;
}

/** Write one scene's draw function as `scenes/slot-{letter}.ts`. */
/**
 * Write each code-bearing overlay's body as `overlay-code/<overlayId>.ts`, and
 * delete anything else in that directory.
 *
 * The prune is not tidiness. Overlay ids are the FILE names here, so an id that
 * stops being emitted (slot D's tracked overlay became `code-…`, not
 * `tracked-…`) leaves a stale, still-compiling module behind that nothing
 * imports — a second, older answer to "what does the reticle draw?" sitting
 * next to the real one.
 */
function writeOverlayCodeFiles(
  bodies: Map<string, EmittedBody>,
  extraHeaders: ReadonlyMap<string, string[]>,
): void {
  const dir = path.join(V1_DIR, "overlay-code");
  fs.mkdirSync(dir, { recursive: true });
  const written = new Set<string>();
  for (const [overlayId, body] of bodies) {
    const source =
      generatedHeader([
        `// The draw body of overlay ${overlayId}, hydrated out of the piece's`,
        "// per-overlay code file (composition.json never holds overlay code).",
        "//",
        ...(extraHeaders.get(overlayId) ?? []),
        ...fidelityLines(body),
      ]) + `export const ${identFromId(overlayId)}_DRAW = ${templateLiteral(body.source)};\n`;
    const file = `${overlayId}.ts`;
    fs.writeFileSync(path.join(dir, file), source, "utf-8");
    written.add(file);
  }
  const pruned: string[] = [];
  for (const entry of fs.readdirSync(dir)) {
    if (written.has(entry)) continue;
    fs.rmSync(path.join(dir, entry), { force: true });
    pruned.push(entry);
  }
  logger.info(
    { tag: TAG, op: "overlay-code", dir, count: bodies.size, pruned },
    "wrote overlay code",
  );
}

/* ================================================================== *
 * Slot D: a tracked overlay, baked into a plain code overlay
 *
 * The source piece draws slot D's green reticle with a REAL `tracked` overlay
 * over a real 145-sample object track. The shipped demo does not, and the
 * difference is deliberate:
 *
 *  - Object tracking needs a local model libi provisions on FIRST USE
 *    (`requireDeps("libi", ["tracking-pyenv"])` inside
 *    `libi.compute_object_track`). A brand-new user has not installed it, so
 *    the demo would be showing off the one feature they cannot yet run.
 *  - A real tracked overlay puts tracking controls in the inspector, bound to
 *    a track the user cannot regenerate. That reads as "libi tracked this for
 *    you just now", which is not what happened.
 *
 * This is not an exception to how the film works — it is the rule. Five of the
 * six slots are already mock UI: slot A's "chat window" is a drawing, and slot
 * D's telemetry strip below the panel is drawn by the scene. Slot D's reticle
 * simply joins them.
 *
 * WHAT IS PRESERVED: the pixels. The boxes below are not re-derived from a
 * formula — they are what `sampleTrackedOverlay` + `resolveTrackedRect` (the
 * engine's own placement path, the same one preview and export use) resolve
 * for this overlay, evaluated here once per rendered frame and written down.
 * The scale from source-video pixels to composition pixels comes from the
 * owning video overlay's rect, fit and probed source dimensions, exactly as
 * `resolveTrackedSpace` computes it — nothing about the panel's size is
 * hardcoded, so a re-cut film re-bakes correctly instead of drifting.
 * ================================================================== */

/** One reticle box in COMPOSITION pixels — `[x, y, w, h]` — or null for a
 *  frame the track does not place (no sample, or the subject not visible). */
type BakedBox = [number, number, number, number] | null;

/**
 * Composition pixels, rounded to 1/100 of a pixel.
 *
 * The track file this replaces was emitted at full float precision, and that
 * was right for it: those were SOURCE-video box coordinates that the renderer
 * then scaled and interpolated, so rounding compounded. These are the final
 * on-screen numbers — nothing happens to them after this — and 0.01 px is two
 * orders of magnitude below the antialiasing of the 2 px stroke drawn at them.
 * The box travels ~1.5 px per frame; the rounding is 0.7% of one frame's move.
 */
const BOX_DECIMALS = 2;

function roundBox(n: number): number {
  const f = 10 ** BOX_DECIMALS;
  return Math.round(n * f) / f;
}

interface BakedOverlay {
  /** The id the baked overlay ships under. */
  id: string;
  /** The draw body, ready for `writeOverlayCodeFiles`. */
  body: EmittedBody;
  /** Header lines for the emitted code file, derived from the bake. */
  header: string[];
  /** The plain `code` overlay that replaces the tracked one, minus the
   *  `drawFunction` reference the caller splices in. */
  overlay: Record<string, unknown>;
  frames: number;
  gaps: number;
  ownerOverlayId: string;
  scaleX: number;
  scaleY: number;
}

/**
 * A `tracked` overlay + its track → a plain `code` overlay that draws the same
 * thing from a baked box list.
 *
 * `drawBody` is the ORIGINAL body, already corrected and font-bundled. It is
 * embedded VERBATIM inside a one-argument function, called with the same
 * context the tracked renderer would have passed it: the shared `ctx`, already
 * translated to the box origin, and `width`/`height` set to the box size. That
 * is the whole trick — the reticle code is not rewritten, so there is no
 * "does the new version still draw the same thing?" question to answer.
 */
function bakeTrackedOverlay(
  manifest: CompositionManifest,
  tracked: Extract<PersistedOverlay, { kind: "tracked" }>,
  track: Track,
  sourceDims: ReadonlyMap<string, { width: number; height: number }>,
  drawBody: EmittedBody,
): BakedOverlay {
  // `buildComposition` copies `files.mediaWidth/mediaHeight` onto every video
  // overlay as `sourceWidth`/`sourceHeight`, and `resolveTrackedSpace` divides
  // by exactly those. Reproduce that hydration from the file rows — without it
  // the space silently falls back to "the source fills the rect", which is a
  // different (and wrong) scale for a 1920x1080 clip in a 1280x720 panel.
  const overlays = (manifest.overlays ?? []).map((o) => {
    if (o.kind !== "video") return o as unknown as Overlay;
    const dims = sourceDims.get(o.fileId);
    if (!dims) {
      throw new Error(
        `video overlay ${o.id} mounts file ${o.fileId}, which has no probed ` +
          `mediaWidth/mediaHeight — the tracked bake would be computed at the ` +
          `wrong scale.`,
      );
    }
    return { ...o, sourceWidth: dims.width, sourceHeight: dims.height } as unknown as Overlay;
  });

  // THE track a renderer actually samples, not the one on disk.
  // `prepareOverlayTracks` is the one hydration seam preview, export and the
  // verify route all pass a track through — it merges the agent's re-anchor
  // and applies this overlay's size / position stabilization policy. Baking
  // the raw sidecar instead would shift the reticle by ~2.4 px against what
  // the film renders today, which is small but is the difference between
  // "the same picture" and "close enough".
  const prepared = prepareOverlayTracks({ [track.id]: track }, overlays)[track.id];

  const space = resolveTrackedSpace(tracked, prepared, overlays);
  if (!space.video) {
    throw new Error(
      `tracked overlay ${tracked.id} has no owning video overlay — the bake ` +
        `would fall back to the identity space and put the reticle at source ` +
        `scale over the frame origin.`,
    );
  }

  const frameSize = { width: manifest.width, height: manifest.height };
  // One box per rendered frame, plus the closing one. `elementTiming` gives the
  // draw body `frame = round((globalTime - startTime) * fps)`, and global
  // frames are integers, so this index IS that frame number — no interpolation
  // and no fps assumption at runtime.
  const count = Math.round(tracked.duration * manifest.fps) + 1;
  const boxes: BakedBox[] = [];
  for (let f = 0; f < count; f++) {
    const globalTime = tracked.startTime + f / manifest.fps;
    const sample = sampleTrackedOverlay(tracked, prepared, overlays, globalTime);
    if (!sample || !sample.visible) {
      boxes.push(null);
      continue;
    }
    const rect = resolveTrackedRect(sample, tracked, frameSize);
    boxes.push([roundBox(rect.x), roundBox(rect.y), roundBox(rect.w), roundBox(rect.h)]);
  }
  const gaps = boxes.filter((b) => b === null).length;
  if (gaps === boxes.length) {
    throw new Error(`tracked overlay ${tracked.id} resolved no boxes at all — refusing to bake`);
  }

  const id = tracked.id.startsWith("tracked-")
    ? `code-${tracked.id.slice("tracked-".length)}`
    : `code-${tracked.id}`;

  const rows = boxes.map(
    (b) => `  ${b === null ? "null" : `[${b.map((n) => String(n)).join(", ")}]`},`,
  );

  const source = [
    "// Slot D's tracking reticle. The path below was produced by libi's real",
    "// object tracking on this footage and then baked, frame by frame, into the",
    "// composition coordinates it draws at — so this overlay needs no track, no",
    "// tracking model, and no runtime transform.",
    "const RETICLE = context;",
    "const RETICLE_CTX = RETICLE.ctx;",
    "",
    "// INK PIN — two all-but-invisible pixels at opposite corners of the rect.",
    "// A plain code overlay is contain-FIT: the renderer probes the union alpha",
    "// bbox of what this body draws and scales it to fill the rect",
    "// (lib/overlays/code-content-fit.ts). Every other code overlay in this film",
    "// happens to paint corner to corner, so the fit is the identity for them.",
    "// This one paints a small box that MOVES, and without the pin the probe",
    "// would measure a fraction of the frame and blow the reticle up ~2.3x.",
    "// Alpha 0.01 is one step above transparent: it registers as ink and cannot",
    "// register as a pixel.",
    'RETICLE_CTX.fillStyle = "rgba(52,211,153,0.01)";',
    "RETICLE_CTX.fillRect(0, 0, 1, 1);",
    "RETICLE_CTX.fillRect(RETICLE.width - 1, RETICLE.height - 1, 1, 1);",
    "",
    "// [x, y, w, h] in composition pixels, one row per frame of this overlay.",
    "// null = a frame the subject was not visible on, which drew nothing.",
    "const RETICLE_BOXES = [",
    ...rows,
    "];",
    "const RETICLE_I =",
    "  RETICLE.frame < 0",
    "    ? 0",
    "    : RETICLE.frame >= RETICLE_BOXES.length",
    "      ? RETICLE_BOXES.length - 1",
    "      : RETICLE.frame;",
    "const RETICLE_BOX = RETICLE_BOXES[RETICLE_I];",
    "if (RETICLE_BOX) {",
    "  RETICLE_CTX.save();",
    "  RETICLE_CTX.translate(RETICLE_BOX[0], RETICLE_BOX[1]);",
    "  // The reticle body, verbatim, called exactly as the tracked renderer",
    "  // called it: same ctx (already at the box origin), box-sized width and",
    "  // height, and this overlay's own element-local clock.",
    "  (function (context) {",
    drawBody.source,
    "  })({ ...RETICLE, width: RETICLE_BOX[2], height: RETICLE_BOX[3] });",
    "  RETICLE_CTX.restore();",
    "}",
  ].join("\n");

  // Everything a `tracked` overlay carries that a `code` overlay does not.
  // Listed rather than picked the other way round on purpose: the shared
  // fields (hidden, group, displayName, anchor, flipH/V, transform3d,
  // keyframes, effects …) must survive, and an allowlist would drop the next
  // one silently. A key added to the tracked variant and not to this list
  // would be emitted onto a code overlay, which `saveManifest` would then
  // persist as junk — so the list is checked against the real type below.
  const TRACKING_ONLY: readonly (keyof Extract<PersistedOverlay, { kind: "tracked" }>)[] = [
    "trackId",
    "content",
    "fit",
    "scale",
    "smoothing",
    "sizeMode",
    "maxBoxScale",
    "positionMode",
    "offset",
  ];
  const rest: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(tracked as Record<string, unknown>)) {
    // `version` is the per-install optimistic-concurrency counter every other
    // overlay drops here too.
    if (key === "id" || key === "kind" || key === "version") continue;
    if ((TRACKING_ONLY as readonly string[]).includes(key)) continue;
    rest[key] = value;
  }

  return {
    id,
    body: { ...drawBody, source },
    header: [
      `// THIS WAS A \`tracked\` OVERLAY IN THE SOURCE PIECE (${tracked.id}), driven by a`,
      "// real 145-sample object track. It ships as a plain `code` overlay with the",
      "// track's boxes baked in, because object tracking needs a local model libi",
      "// provisions on first use and the demo must not depend on it — see the",
      "// \"Slot D\" section of scripts/extract-onboarding-piece.ts for the full",
      "// reasoning. The boxes are what the engine's own placement path resolved,",
      "// so the reticle draws where it always drew.",
      "//",
      `// ${count - gaps} of ${count} frames carry a box; ${gaps} are gaps the subject was not`,
      "// visible on. Coordinates are composition pixels rounded to 2 decimals.",
      "//",
    ],
    // Everything the tracked overlay carried that a code overlay also carries
    // (z, opacity, startTime, duration, group, effects, keyframes …) is kept;
    // the tracking-only fields are dropped by the destructure above.
    overlay: {
      id,
      kind: "code",
      ...rest,
      rect: { x: 0, y: 0, width: manifest.width, height: manifest.height },
    },
    frames: count,
    gaps,
    ownerOverlayId: space.video.id,
    scaleX: space.scaleX,
    scaleY: space.scaleY,
  };
}

interface DefinitionParts {
  /** The film's beats — one per full-frame background layer, in time order. */
  beats: { name: string; startTime: number; duration: number }[];
  overlays: unknown[];
  audioClips: unknown[];
  codeImports: string[];
  totalSeconds: number;
  /** Where the last background layer ends. Everything after it is finale. */
  beatSeconds: number;
  heldToEnd: number;
  /** Pairs of overlays that share a `z` AND overlap in time — the count that
   *  makes array order load-bearing rather than cosmetic. */
  tiedPairs: number;
  /** Font substitutions on overlay properties, and inside draw code. */
  propFontSubs: number;
  codeFontSubs: number;
  /** On-screen strings the emitter corrected (see TEXT_CORRECTIONS). */
  textCorrections: TextCorrection[];
  /** The tracked overlay, as baked into a plain code overlay. */
  baked: BakedOverlay;
  /** The id the tracked overlay carried in the SOURCE piece. */
  bakedFrom: string;
}

function writeDefinitionFile(parts: DefinitionParts): void {
  const body = serializeTs(
    {
      version: "v1",
      name: DEFINITION_NAME,
      width: 1920,
      height: 1080,
      fps: 30,
      beats: parts.beats,
      overlays: parts.overlays,
      audioClips: parts.audioClips,
    },
    "",
  );

  const source =
    generatedHeader([
      `// from the real \`${PIECE_NAME}\` piece.`,
      "//",
      `// THE FILM RUNS ${parts.totalSeconds.toFixed(1)} SECONDS. Its ${parts.beats.length} background layers cover`,
      `// only the first ${parts.beatSeconds.toFixed(1)}, and the difference is not slack:`,
      "// `getCompositionFrames` is the latest overlay or audio end, and the",
      `// finale runs on top of full-frame video and the end card, with ${parts.heldToEnd}`,
      "// overlays deliberately holding to the last frame so the card stays on",
      "// screen long enough to read. Shorten one of those durations and the film",
      "// gets shorter with nothing else failing.",
      "//",
      "// THERE ARE NO SCENES. The six beats were canvas scenes in the piece this",
      "// was first extracted from; a scene had no startTime, rect, z or opacity,",
      "// so the six layers a user most wants to nudge were the only ones the",
      "// editor could not move. They are full-frame `code` overlays at z 0 now,",
      "// laid end to end, and the canvas-scene layer is gone from the product.",
      "//",
      "// Keyframe `t` values are normalized 0→1 of their own overlay's duration.",
      "// They were rescaled by hand when the end card grew from 1.4 s to 11.4 s so",
      "// the animations kept their real-time pacing and then hold at `t: 1`. They",
      "// are odd-looking on purpose — do not round or re-normalize them.",
      "//",
      "// Overlay order is the PIECE's order, not sorted. `overlaysActiveAt` sorts",
      `// by \`z\` with a stable sort, and ${parts.tiedPairs} pairs of overlays here share a`,
      "// `z` and overlap in time — array order is their stacking tiebreak.",
      "// Sorting for readability would restack the end card.",
      "//",
      "// Media is named by slug, never by fileId, and per-overlay `version`",
      "// counters are dropped: both are per-install bookkeeping that means",
      "// nothing on the machine that downloads this.",
      "//",
      "// FONTS DIVERGE FROM THE SOURCE PIECE, deliberately. The piece asks for",
      "// `Helvetica Neue` and `Menlo` — both macOS-only — in overlay properties",
      `// (${parts.propFontSubs} of them) and in overlay draw code (${parts.codeFontSubs}). Every one is`,
      "// mapped to a family libi bundles, so the film renders identically on",
      "// Windows and Linux instead of falling through to whatever face the",
      "// platform picks. The source piece is left untouched; if you diff the two",
      "// and see different font strings, THAT IS THE POINT. Each substitution is",
      "// listed in the file it applies to and logged under op `font-substituted`",
      "// / `font-in-code`.",
      "//",
      "// SLOT D SHIPS NO OBJECT TRACK, also deliberately. The source piece draws",
      `// its green reticle with a \`tracked\` overlay (\`${parts.bakedFrom}\`) over a real`,
      `// track. Here it is the plain \`code\` overlay \`${parts.baked.id}\`, drawing the`,
      "// identical reticle from that track's boxes baked into its draw function —",
      "// object tracking provisions a local model on first use that a brand-new",
      "// user has not installed, and a live tracked overlay would put tracking",
      "// controls in their inspector for a track they cannot regenerate. `tracks`",
      "// is therefore not a field of this definition at all — see the \"Slot D\"",
      "// section of scripts/extract-onboarding-piece.ts.",
      ...(parts.textCorrections.length === 0
        ? []
        : [
            "//",
            "// ON-SCREEN STRINGS the piece got wrong about libi are corrected on the",
            "// way out, listed in the file each applies to and logged under op",
            "// `text-corrected`:",
            ...parts.textCorrections.map((c) => `//   ${c.owner}: ${c.from} -> ${c.to}`),
          ]),
    ]) +
    `import type { OnboardingPieceDefinition } from "../types";\n` +
    `${parts.codeImports.join("\n")}\n\n` +
    `export const ONBOARDING_PIECE_V1: OnboardingPieceDefinition = ${body};\n`;

  fs.writeFileSync(path.join(V1_DIR, "index.ts"), source, "utf-8");
  logger.info(
    {
      tag: TAG,
      op: "definition",
      path: path.join(V1_DIR, "index.ts"),
      beats: parts.beats.length,
      overlays: parts.overlays.length,
      audioClips: parts.audioClips.length,
      seconds: parts.totalSeconds,
    },
    "wrote index.ts",
  );
}

/** A plain code overlay's draw body. The tracked overlay's body is reached
 *  through the bake instead — see `bakeTrackedOverlay`. */
function codeBodyOf(overlay: PersistedOverlay): string | null {
  return overlay.kind === "code" ? overlay.drawFunction : null;
}

async function emitDefinition(
  pieceId: string,
  hydrated: CompositionManifest,
  slugByFileId: Map<string, string>,
): Promise<void> {
  // `loadManifest` MIRRORS a text overlay's `reveal` into `effects.in` for the
  // renderer; `saveManifest` calls this to take it back out before anything is
  // written down. That strip is not cosmetic — persisting the mirror is what
  // caused the "can't remove a reveal" bug: clearing `reveal` left a stale
  // `effects.in` behind, and `effectInToReveal` resurrected it on the next
  // load.
  //
  // This emitter writes a PERSISTED, HAND-EDITABLE artifact, which is exactly
  // the situation the strip exists for — more so than a normal manifest,
  // because a resurrected reveal in committed TypeScript is far harder to spot
  // than one in `~/.libi`. Emit what the piece actually persists, not what the
  // loader added for the renderer's benefit.
  const manifest = stripRevealMirror(hydrated);

  const ctx: DefinitionContext = { slugByFileId, substitutions: [] };
  const inCode: FontSubstitution[] = [];
  const corrected: TextCorrection[] = [];

  // ---- no scenes ------------------------------------------------------
  // The film's six beats used to be canvas scenes; they are full-frame `code`
  // overlays at z 0 now, and the scene layer is gone from the product. A piece
  // that still carries scenes has not been migrated, and emitting from it would
  // silently drop six background layers — every beat would render on black.
  const legacy = manifest as { sceneOrder?: string[]; scenes?: unknown[] };
  if ((legacy.sceneOrder?.length ?? 0) > 0 || (legacy.scenes?.length ?? 0) > 0) {
    throw new Error(
      `piece ${pieceId} still holds ${legacy.sceneOrder?.length ?? 0} scene(s). Canvas scenes ` +
        `were retired; run scripts/migrate-scenes-to-overlays.ts --piece ${pieceId} --execute ` +
        `first, then re-extract.`,
    );
  }

  // ---- the tracked overlay, resolved before anything is emitted -------
  // Its track is READ (that is where the baked boxes come from) but never
  // emitted: the definition ships no `tracks` field at all.
  const trackedOverlays = (manifest.overlays ?? []).filter(
    (o): o is Extract<PersistedOverlay, { kind: "tracked" }> => o.kind === "tracked",
  );
  if (trackedOverlays.length !== 1) {
    throw new Error(
      `expected exactly one tracked overlay to bake, found ${trackedOverlays.length}. ` +
        `The bake is written for slot D's single reticle; teach it the general case ` +
        `before adding a second.`,
    );
  }
  const tracked = trackedOverlays[0];
  if (tracked.content.kind !== "code") {
    throw new Error(
      `tracked overlay ${tracked.id} mounts ${tracked.content.kind} content — only a ` +
        `code body can be baked into a plain code overlay.`,
    );
  }
  const loaded: Track | null = await readTrack(pieceId, tracked.trackId);
  if (!loaded) throw new Error(`track ${tracked.trackId} has no file on disk`);
  const db = getDb();
  const row = db.select().from(tracks).where(eq(tracks.id, tracked.trackId)).all();
  if (row.length !== 1) throw new Error(`track ${tracked.trackId} has no db row`);
  if (loaded.samples.length !== row[0].sampleCount) {
    // `readTrack` normalizes (it re-derives samples from segments). If that
    // ever changes the count, the baked reticle silently follows a different
    // path than the piece does.
    throw new Error(
      `track ${tracked.trackId}: read ${loaded.samples.length} samples, db says ${row[0].sampleCount}`,
    );
  }
  // `resolveTrackedSpace` divides by the FILE's probed dimensions — never the
  // panel's — so the bake reads them off the same rows the app hydrates from.
  const sourceDims = new Map<string, { width: number; height: number }>();
  for (const f of db.select().from(filesTable).where(eq(filesTable.pieceId, pieceId)).all()) {
    if (f.mediaWidth && f.mediaHeight) {
      sourceDims.set(f.id, { width: f.mediaWidth, height: f.mediaHeight });
    }
  }
  const trackedBody = emitBody(tracked.id, tracked.content.drawFunction);
  inCode.push(...trackedBody.substitutions);
  corrected.push(...trackedBody.corrections);
  const baked = bakeTrackedOverlay(manifest, tracked, loaded, sourceDims, trackedBody);

  // ---- overlays, in the piece's own order ---------------------------
  // `loadManifest` has already hydrated every code body out of its
  // per-overlay file, so the bodies are here rather than on disk.
  const bodies = new Map<string, EmittedBody>();
  const extraHeaders = new Map<string, string[]>([[baked.id, baked.header]]);
  const overlays = (manifest.overlays ?? []).map((overlay) => {
    if (overlay.kind === "tracked") {
      // Slot D's reticle: emitted as the plain code overlay `baked` describes,
      // in the tracked overlay's own array position so the z tiebreak holds.
      bodies.set(baked.id, baked.body);
      const mapped = toDefinitionValue(baked.overlay, baked.id, ctx) as Record<string, unknown>;
      mapped.drawFunction = expr(`${identFromId(baked.id)}_DRAW`);
      return mapped;
    }
    const body = codeBodyOf(overlay);
    if (body !== null) {
      if (!body.trim()) throw new Error(`overlay ${overlay.id} hydrated to an empty code body`);
      const emitted = emitBody(overlay.id, body);
      bodies.set(overlay.id, emitted);
      inCode.push(...emitted.substitutions);
      corrected.push(...emitted.corrections);
    }
    if (overlay.kind !== "text" && "shadow" in overlay) {
      // Only `drawTextOverlay` reads `shadow`, so this one renders nothing.
      // Emitted anyway (see OnboardingOverlayExtras) — but not silently.
      logger.warn(
        { tag: TAG, op: "inert-field", overlayId: overlay.id, kind: overlay.kind, field: "shadow" },
        "overlay carries a field its kind does not render — kept verbatim",
      );
    }
    const { version: _version, ...rest } = overlay as PersistedOverlay & { version?: number };
    const mapped = toDefinitionValue(rest, overlay.id, ctx) as Record<string, unknown>;
    if (body !== null) mapped.drawFunction = expr(`${identFromId(overlay.id)}_DRAW`);
    return mapped;
  });
  writeOverlayCodeFiles(bodies, extraHeaders);
  const codeImports = [...bodies.keys()].map(
    (id) => `import { ${identFromId(id)}_DRAW } from "./overlay-code/${id}";`,
  );

  // The track file the previous shape shipped. Removed here rather than by
  // hand so a checkout that regenerates cannot be left holding both answers.
  const staleTrackFile = path.join(V1_DIR, "track.ts");
  if (fs.existsSync(staleTrackFile)) {
    fs.rmSync(staleTrackFile);
    logger.info({ tag: TAG, op: "track-removed", path: staleTrackFile }, "removed track.ts");
  }

  // ---- audio clips ---------------------------------------------------
  const audioClips = (manifest.audioClips ?? []).map(
    (clip) => toDefinitionValue(clip, clip.id, ctx) as Record<string, unknown>,
  );

  // ---- beats, from the full-frame background layers -------------------
  // The user-facing account of the film ("Beats: type the prompt, agent builds,
  // …") is what `describeOnboardingPiece` reads out to a first-run user. It
  // used to come from the scene NAMES. Sniffing `displayName` for the `SLOT X —`
  // prefix would keep that working while making a layer rename silently empty
  // the description, so the beat list is emitted here as data instead.
  //
  // A beat is a background: full-frame, at the floor z, painting under
  // everything. That is a structural test, not a naming convention.
  const isBackground = (o: PersistedOverlay): boolean =>
    o.kind === "code" &&
    o.z === 0 &&
    o.rect.x === 0 &&
    o.rect.y === 0 &&
    o.rect.width === manifest.width &&
    o.rect.height === manifest.height;
  const beats = (manifest.overlays ?? [])
    .filter(isBackground)
    .sort((a, b) => a.startTime - b.startTime)
    .map((o) => ({ name: o.displayName ?? o.id, startTime: o.startTime, duration: o.duration }));
  if (beats.length === 0) {
    throw new Error(
      "no full-frame background overlays found — the film would have no beats to describe. " +
        "Backgrounds are code overlays at z 0 covering the whole frame.",
    );
  }

  // ---- runtime facts, derived not asserted ----------------------------
  const fps = manifest.fps;
  const endOf = (o: { startTime: number; duration: number }) => o.startTime + o.duration;
  const beatSeconds = beats.reduce((n, b) => Math.max(n, b.startTime + b.duration), 0);
  const latest = Math.max(
    ...(manifest.overlays ?? []).map(endOf),
    ...(manifest.audioClips ?? []).map(endOf),
  );
  // `endTimeMs` / `toMs` are shared with the consistency test on purpose —
  // see the note on `toMs` in lib/onboarding/piece/types.ts.
  const heldToEnd = (manifest.overlays ?? []).filter((o) => endTimeMs(o) === toMs(latest)).length;

  // Counted, not asserted: this is the number the header cites as the reason
  // overlay order is left alone. A wrong number there invites the next reader
  // to "clean up" the order.
  const all = manifest.overlays ?? [];
  let tiedPairs = 0;
  for (let i = 0; i < all.length; i++) {
    for (let j = i + 1; j < all.length; j++) {
      const a = all[i];
      const b = all[j];
      if (a.z === b.z && a.startTime < endOf(b) && b.startTime < endOf(a)) tiedPairs++;
    }
  }

  writeDefinitionFile({
    beats,
    overlays,
    audioClips,
    codeImports,
    totalSeconds: latest,
    beatSeconds,
    heldToEnd,
    tiedPairs,
    propFontSubs: ctx.substitutions.length,
    codeFontSubs: inCode.length,
    textCorrections: corrected,
    baked,
    bakedFrom: tracked.id,
  });

  logger.warn(
    {
      tag: TAG,
      op: "tracked-baked",
      from: tracked.id,
      to: baked.id,
      trackId: tracked.trackId,
      samples: loaded.samples.length,
      frames: baked.frames,
      gaps: baked.gaps,
      ownerOverlayId: baked.ownerOverlayId,
      scaleX: baked.scaleX,
      scaleY: baked.scaleY,
      decimals: BOX_DECIMALS,
    },
    "tracked overlay baked into a plain code overlay — the definition ships no track",
  );
  for (const c of corrected) {
    logger.warn(
      { tag: TAG, op: "text-corrected", owner: c.owner, from: c.from, to: c.to, why: c.why },
      "on-screen string corrected in the emitted definition",
    );
  }
  for (const s of ctx.substitutions) {
    logger.warn(
      { tag: TAG, op: "font-substituted", owner: s.owner, field: s.field, from: s.from, to: s.to },
      "font family is not bundled — mapped in the emitted definition",
    );
  }
  for (const s of inCode) {
    logger.warn(
      { tag: TAG, op: "font-in-code", owner: s.owner, from: s.from, to: s.to },
      "draw code set an unbundled font — rewritten to a bundled family",
    );
  }
  logger.info(
    {
      tag: TAG,
      op: "definition-done",
      seconds: latest,
      frames: Math.round(latest * fps),
      beatSeconds,
      heldToEnd,
      substituted: ctx.substitutions.length,
      unbundledInCode: inCode.length,
      corrected: corrected.length,
      bakedFrames: baked.frames,
    },
    "emitted the composition definition",
  );
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const pieceId = resolvePieceId(args.pieceId);
  logger.info(
    { tag: TAG, op: "start", pieceId, rehash: args.rehash, force: args.force },
    "extracting onboarding piece",
  );

  // Loaded ONCE and passed down: `loadManifest` hydrates every overlay's code
  // body out of its per-overlay file, and the definition emitter needs the
  // hydrated bodies, not the empty strings `composition.json` holds.
  const manifest = await loadManifest(pieceId);

  const fileIds = collectReferencedFileIds(pieceId, manifest);
  const { assets, restagedSlugs, slugByFileId } = await stageAssets(pieceId, fileIds, args);
  assertNoOrphans(assets);
  writeManifest(assets);
  writeGenerated(assets, restagedSlugs);
  await emitDefinition(pieceId, manifest, slugByFileId);

  logger.info(
    {
      tag: TAG,
      op: "done",
      pieceId,
      count: assets.length,
      bytes: assets.reduce((n, a) => n + a.bytes, 0),
      restaged: restagedSlugs,
    },
    "extraction complete",
  );
}

// CLI entry only. `slugForFilename` is exported for its unit test, and an
// import must not run an extraction.
if (process.argv[1] && process.argv[1].endsWith("extract-onboarding-piece.ts")) {
  main().catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ tag: TAG, op: "failed", err: message }, "extraction failed");
    // The logger writes to ~/.libi/logs/libi.log, not the terminal, and this is
    // an operator-run script — a silent non-zero exit is a bug report waiting to
    // happen. stderr, not console.* (banned for anything importing from lib/).
    process.stderr.write(`[onboarding:extract] ${message}\n`);
    process.exitCode = 1;
  });
}
