import type { Input, InputAudioTrack, InputTrack, InputTrackQuery, InputVideoTrack } from "mediabunny";

/**
 * The track the preview decodes, chosen by the same rule as the server's
 * `lib/ffmpeg/probe.ts#primaryStreamIndex`, so the preview, the proxy and the
 * export mix all play one stream (Review M6):
 * - the first track of its type flagged default, else the first, in file order;
 * - for video, a still-image track (cover art: MJPEG, PNG, GIF, ... as a video
 *   track) never, while a real video exists.
 *
 * mediabunny's own pick is not that rule. Since 1.42 it also ranks by pairing
 * and then by peak bitrate, which 1.57 reads from the MP4 `btrt` box; ffprobe
 * can't see that box, so on a file with two default audio tracks 1.60 took the
 * higher-bitrate second one while the proxy carried the first. `getTracks()`
 * has returned file order since 1.42, which is ffprobe's stream order, so
 * `track.number` breaks ties the same way.
 *
 * Tracks the two demuxers disagree about:
 * - a Matroska track mediabunny drops (disabled, or compressed): the server
 *   passes over it too (`lib/ffmpeg/matroska-tracks.ts`);
 * - a still image stored in a way mediabunny can't name (Matroska
 *   V_MS/VFW/FOURCC, where only the codec private data says PNG): the preview
 *   may pick it, can't decode it (codec null), and plays the proxy, which
 *   carries the server's pick.
 * `__tests__/integration/primary-track-parity.test.ts` checks the two picks
 * over real files.
 */

/** Container codec ids of still-image video tracks, as mediabunny reports
 *  them (`getInternalCodecId`): Matroska CodecIDs and ISOBMFF sample entry
 *  types. These are the ones ffmpeg names mjpeg, png, bmp, gif, tiff and
 *  jpeg2000, which the server's rule skips. */
const STILL_IMAGE_CODEC_IDS = new Set([
  "V_MJPEG",
  "jpeg", "mjpa", "AVDJ", "AVRn", "dmb1",
  "png ", "MPNG",
  "gif ",
  "tiff",
  "WRLE",
  "mjp2",
]);

async function isStillImage(track: InputVideoTrack): Promise<boolean> {
  if ((await track.getCodec()) !== null) return false; // every codec mediabunny decodes moves
  const id = await track.getInternalCodecId();
  return typeof id === "string" && STILL_IMAGE_CODEC_IDS.has(id);
}

const DEFAULT_THEN_FILE_ORDER: InputTrackQuery<InputTrack> = {
  sortBy: async (track: InputTrack) => [(await track.getDisposition()).default ? 0 : 1, track.number],
};

export function primaryAudioTrack(input: Input): Promise<InputAudioTrack | null> {
  return input.getPrimaryAudioTrack(DEFAULT_THEN_FILE_ORDER);
}

export async function primaryVideoTrack(input: Input): Promise<InputVideoTrack | null> {
  const pick = await input.getPrimaryVideoTrack(DEFAULT_THEN_FILE_ORDER);
  if (!pick || !(await isStillImage(pick))) return pick;
  // The pick is a still image: take the first default MOVING track, else the
  // first moving one, as the server does. Only images: keep the pick.
  const all = await input.getVideoTracks();
  const still = await Promise.all(all.map(isStillImage));
  const moving = all.filter((_, i) => !still[i]);
  if (moving.length === 0) return pick;
  return input.getPrimaryVideoTrack({
    ...DEFAULT_THEN_FILE_ORDER,
    filter: (t) => moving.includes(t),
  } as InputTrackQuery<InputVideoTrack>);
}
