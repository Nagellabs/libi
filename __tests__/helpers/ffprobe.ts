// Legacy helpers — kept to avoid breaking existing imports. New code should
// import from `./media.ts`.
import { probe } from "./media";

export { probe as probeMedia } from "./media";

export async function probeDuration(filePath: string): Promise<number | null> {
  try {
    return (await probe(filePath)).duration;
  } catch {
    return null;
  }
}

export async function probeVideoCodec(filePath: string): Promise<string | null> {
  try {
    return (await probe(filePath)).videoStream?.codec ?? null;
  } catch {
    return null;
  }
}
