/**
 * "Send to inbox": the user-only action that takes a draft to a platform's own
 * inbox / drafts (TikTok's inbox upload) instead of publishing it.
 *
 * It is a normal provider update — publish the draft — whose target carries the
 * draft handoff music mode, which the adapter writes as the provider's own
 * inbox flag. Nothing here names a provider: which platforms have an inbox is
 * `PLATFORM_MUSIC_RULES[platform].draftHandoff`, and the wire shape belongs to
 * the adapter (`toUpdateBody`).
 *
 * Refusals are plain sentences for the UI, never thrown: the button explains
 * why it cannot send instead of failing after a click.
 */
import { PLATFORM_MUSIC_RULES } from "./music-policy";
import { platformLabel } from "./catalog";
import type { SocialPost, UpdatePostInput } from "./types";

export type InboxRefusalCode = "not_a_draft" | "no_inbox_platform" | "other_targets" | "no_settings";

export type InboxPlan =
  | { ok: true; platforms: string[]; patch: Omit<UpdatePostInput, "requestId"> }
  | { ok: false; code: InboxRefusalCode; message: string };

const hasInbox = (platform: SocialPost["targets"][number]["platform"]): boolean => PLATFORM_MUSIC_RULES[platform]?.draftHandoff === true;

/** What "Send to inbox" would do to this post, or why it cannot. */
export function planInboxSend(post: SocialPost): InboxPlan {
  if (post.status !== "draft") {
    return { ok: false, code: "not_a_draft", message: "Only a draft can be sent to an inbox." };
  }
  const inbox = post.targets.filter((t) => hasInbox(t.platform));
  if (inbox.length === 0) {
    return { ok: false, code: "no_inbox_platform", message: "None of this post's platforms has an inbox to send a draft to." };
  }
  const others = post.targets.filter((t) => !hasInbox(t.platform));
  if (others.length > 0) {
    const names = [...new Set(others.map((t) => platformLabel(t.platform)))].join(" and ");
    return {
      ok: false,
      code: "other_targets",
      message: `This draft also goes to ${names}, and sending it would post there too. Remove ${names} from the post (Edit), or make a separate draft for ${[...new Set(inbox.map((t) => platformLabel(t.platform)))].join(" and ")}.`,
    };
  }
  const stamped = post.libi?.targetOptions;
  const targets: NonNullable<UpdatePostInput["targets"]> = [];
  for (let i = 0; i < post.targets.length; i++) {
    const t = post.targets[i];
    const options = stamped?.[i];
    if (!options || options.platform !== t.platform) {
      return {
        ok: false,
        code: "no_settings",
        message: "libi does not have this draft's settings (it was not made by libi), so it cannot send it for you. Open it in the composer, or finish it in your provider's own tools.",
      };
    }
    targets.push({ platform: options.platform, accountId: t.accountId, options: { ...options, music: { mode: "draft" } } });
  }
  const mediaUrl = post.libi?.mediaUrl;
  return {
    ok: true,
    platforms: [...new Set(post.targets.map((t) => t.platform))],
    patch: {
      targets,
      when: { mode: "now" },
      ...(mediaUrl ? { media: [{ url: mediaUrl, type: post.media[0]?.type ?? "video" }] } : {}),
      ...(post.libi
        ? {
            libi: {
              pieceId: post.libi.pieceId,
              ...(post.libi.pieceName ? { pieceName: post.libi.pieceName } : {}),
              ...(post.libi.exportFile ? { exportFile: post.libi.exportFile } : {}),
              ...(post.libi.appVersion ? { appVersion: post.libi.appVersion } : {}),
              ...(post.libi.requestId ? { requestId: post.libi.requestId } : {}),
              ...(mediaUrl ? { mediaUrl } : {}),
            },
          }
        : {}),
    },
  };
}
