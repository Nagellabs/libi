import type { MusicUnavailableReason } from "@/lib/social/music-policy";

/** Why an account's catalog can't be listed, in the user's terms (the picker and the Music step). */
export function unavailableLine(reason: MusicUnavailableReason, P: string): string {
  return reason === "needs_facebook_login"
    ? `${P}'s music needs Facebook Login — reconnect the account.`
    : reason === "not_business"
      ? `${P}'s music library isn't available for this account.`
      : reason === "unsupported"
        ? `${P} has no music library libi can reach.`
        : "Couldn't load the music catalog — try again.";
}
