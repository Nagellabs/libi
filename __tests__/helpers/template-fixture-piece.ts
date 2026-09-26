import fs from "node:fs";
import path from "node:path";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { files, tracks } from "@/lib/db/schema/sqlite";
import { seedPiece } from "@/__tests__/helpers/test-db";
import { saveManifest, type CompositionManifest } from "@/lib/composition/persistence";
import { saveUserPreset } from "@/lib/overlays/preset-store";
import { writeTrack } from "@/lib/tracking/storage";

export interface FixtureIds {
  text: string;
  image: string;
  video: string;
  code: string;
  three: string;
  tracked: string;
  clipA: string;
  clipB: string;
  fontFileId: string;
  imageFileId: string;
  videoFileId: string;
  audioFileId: string;
  trackId: string;
}

type TestDb = BetterSQLite3Database<Record<string, never>>;

function seedFile(
  db: TestDb,
  storageDir: string,
  pieceId: string,
  id: string,
  filename: string,
  type: string,
  contentType: string,
  name: string,
) {
  fs.mkdirSync(path.join(storageDir, pieceId), { recursive: true });
  fs.writeFileSync(path.join(storageDir, pieceId, filename), Buffer.from(`bytes-of-${filename}`));
  db.insert(files)
    .values({
      id,
      pieceId,
      filename,
      name,
      description: "",
      type,
      storagePath: `${pieceId}/${filename}`,
      contentType,
      size: 10,
    })
    .run();
}

/** A piece with every overlay kind, a user font, a user caption style, a
 *  tracked-code overlay on a labelled track, and two clips (one inline-linked
 *  to the video, one ducking under it). Storage must already be redirected
 *  to `storageDir` (see the tests' `vi.mock("@/lib/storage")`), and LIBI_HOME
 *  must already point at a temp home (`createTempStorageDir()`) — the track
 *  sidecar and the user preset are written through it, not through storage. */
export async function seedTemplateFixturePiece(
  db: TestDb,
  storageDir: string,
): Promise<{ pieceId: string; ids: FixtureIds }> {
  const pieceId = seedPiece(db as never, { id: "tpl-src" });
  const ids: FixtureIds = {
    text: "text-aaaa",
    image: "img-bbbb",
    video: "vid-cccc",
    code: "code-dddd",
    three: "three-eeee",
    tracked: "trk-ffff",
    clipA: "clip_aaaa",
    clipB: "clip_bbbb",
    fontFileId: "font-file-1",
    imageFileId: "image-file-1",
    videoFileId: "video-file-1",
    audioFileId: "audio-file-1",
    trackId: "trk-1111",
  };
  seedFile(db, storageDir, pieceId, ids.fontFileId, "Brand.ttf", "font", "font/ttf", "Brand");
  seedFile(db, storageDir, pieceId, ids.imageFileId, "logo.png", "image", "image/png", "Logo");
  seedFile(db, storageDir, pieceId, ids.videoFileId, "bg.mp4", "video", "video/mp4", "Background clip");
  seedFile(db, storageDir, pieceId, ids.audioFileId, "music.mp3", "audio", "audio/mpeg", "Music");
  db.insert(tracks)
    .values({
      id: ids.trackId,
      fileId: ids.videoFileId,
      label: "lisa",
      method: "mediapipe",
      framerate: 30,
      durationSec: 4,
      sampleCount: 120,
    })
    .run();
  await writeTrack(pieceId, {
    id: ids.trackId,
    fileId: ids.videoFileId,
    label: "lisa",
    method: "mediapipe" as never,
    framerate: 30,
    durationSec: 4,
    samples: [],
  });
  await saveUserPreset({
    id: "brand-gold",
    name: "Brand gold",
    kind: "text",
    source: "user",
    fields: { color: "#ffd400", stroke: { color: "#000", width: 8 } },
  });

  const manifest: CompositionManifest = {
    width: 1080,
    height: 1920,
    fps: 30,
    overlays: [
      {
        id: ids.text,
        kind: "text",
        startTime: 0,
        duration: 4,
        rect: { x: 0, y: 0, width: 1080, height: 200 },
        z: 5,
        opacity: 1,
        content: "Hello",
        font: `700 64px libifont-${ids.fontFileId}, sans-serif`,
        fontFileId: ids.fontFileId,
        color: "#fff",
        align: "center",
        displayName: "Headline",
        caption: { groupId: "g1", styleRef: "brand-gold", useTrackStyle: true },
      },
      {
        id: ids.image,
        kind: "image",
        startTime: 0,
        duration: 4,
        rect: { x: 10, y: 10, width: 100, height: 100 },
        z: 4,
        opacity: 1,
        fileId: ids.imageFileId,
        displayName: "Logo",
      },
      {
        id: ids.video,
        kind: "video",
        startTime: 0,
        duration: 4,
        rect: { x: 0, y: 0, width: 1080, height: 1920 },
        z: 0,
        opacity: 1,
        fileId: ids.videoFileId,
        displayName: "Background",
        fit: "cover",
      },
      {
        id: ids.code,
        kind: "code",
        startTime: 1,
        duration: 2,
        rect: { x: 0, y: 0, width: 1080, height: 1920 },
        z: 6,
        opacity: 0.9,
        drawFunction: "const { ctx } = context;\nctx.fillStyle = '#f00';\nctx.fillRect(0, 0, 50, 50);",
        displayName: "Sparkle",
      },
      {
        id: ids.three,
        kind: "three",
        startTime: 0,
        duration: 4,
        rect: { x: 0, y: 0, width: 1080, height: 1920 },
        z: 7,
        opacity: 1,
        sceneFunction: "return { update() {} };",
        displayName: "Floating title",
        cameraPreset: "billboard",
      },
      {
        id: ids.tracked,
        kind: "tracked",
        startTime: 0,
        duration: 4,
        rect: { x: 100, y: 100, width: 200, height: 200 },
        z: 8,
        opacity: 1,
        trackId: ids.trackId,
        content: { kind: "code", drawFunction: "const { ctx } = context;\nctx.strokeRect(0, 0, 20, 20);" },
        fit: "tight",
        scale: 1,
        smoothing: "linear",
        displayName: "Name tag",
      },
    ],
    audioClips: [
      {
        id: ids.clipA,
        kind: "inline",
        fileId: ids.videoFileId,
        startTime: 0,
        duration: 4,
        trimStart: 0,
        volume: 1,
        enabled: true,
        linkedOverlayId: ids.video,
        label: "Background audio",
      },
      {
        id: ids.clipB,
        kind: "standalone",
        fileId: ids.audioFileId,
        startTime: 0,
        duration: 4,
        trimStart: 0.5,
        volume: 0.6,
        enabled: true,
        label: "Music",
        duck: {
          sidechainClipIds: [ids.clipA],
          thresholdDb: -20,
          ratio: 4,
          attackMs: 10,
          releaseMs: 200,
          reductionDb: 12,
        },
      },
    ],
  };
  await saveManifest(pieceId, manifest);
  return { pieceId, ids };
}
