import { socialLinkPost, socialLinkAd } from "@/mcp/tools/social-tools";
import { socialLinkPostSchema, socialLinkAdSchema } from "@/mcp/tools/schemas";
import { action, type ActionToolDef } from "@/mcp/tools/action-tool";

// Both kinds are the AGENT's own link of something it created with its own Zernio tools (`createdBy: "agent"`),
// neither is browser-only or approval-gated, so they share one tool. Publishing, scheduling and editing stay
// the user's, from the studio.
export const socialLinkTool: ActionToolDef = {
  name: "libi.social_link",
  description:
    "After you created a Zernio post or ad yourself, link it to the piece it came from so it shows in that piece's Posting tab and on the Social page, and open that tab: `kind` post or ad. Records a link only: it never creates, edits, publishes, pauses or funds anything at the provider. Idempotent.",
  actions: {
    post: action({
      describe:
        "link a post you created yourself (posts_create_post via call_tool) to its piece; linking the same post again is harmless",
      schema: socialLinkPostSchema,
      run: (params) => socialLinkPost(params),
    }),
    ad: action({
      describe:
        "link an AD you created yourself whose creative came from a piece but was never an organic post (a 'dark post'). Do NOT use this for an ad that boosts a post: libi finds those itself (effective_instagram_media_id), and linking one would lose which post it boosts",
      schema: socialLinkAdSchema,
      run: (params) => socialLinkAd(params),
    }),
  },
};
