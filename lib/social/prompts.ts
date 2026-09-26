export type AskKind = "caption" | "decide" | "multi" | "bulk" | "ads" | "analytics" | "post";
export interface AskCtx {
  pieceId?: string;
  pieceName?: string;
  postId?: string;
  exportPath?: string;
  targets?: string[];
}

/**
 * Structured hand-offs for everything the UI deliberately does NOT do — see
 * AGENTS.md's closed action list. Only the agent writes a caption beyond a
 * typed edit, decides where to post, works across pieces/posts, schedules in
 * bulk, or touches ads. Each of these builds a self-contained prompt so
 * `AskAgentButton` never needs its own form.
 */
export function askAgentPrompt(kind: AskKind, ctx: AskCtx): string {
  const piece = ctx.pieceId ? `piece ${ctx.pieceId}${ctx.pieceName ? ` ("${ctx.pieceName}")` : ""}` : "the current piece";
  const targets = ctx.targets?.length ? ctx.targets.join(" and ") : "the accounts I connected";
  switch (kind) {
    case "post":
      return `Post ${piece} to ${targets} using libi.post_piece. Leave it as a Zernio DRAFT and open the Posting tab so I can review — do not schedule or publish.`;
    case "caption":
      return `Write a caption for ${piece} for ${targets}: a strong hook in the first 125 characters, then the point, then up to 5 relevant hashtags. Read the social-posting skill's platform references for limits. Give me the caption only — I will paste it into the Posting tab, do not post anything.`;
    case "decide":
      return `Look at ${piece} and tell me where it should go (${targets}), which post type per platform (Instagram Reel / Feed / Story), and the best time in my timezone. Explain briefly. Do not post anything until I say so.`;
    case "multi":
      return `I want to post several pieces. List my pieces with their latest exports, propose which go to ${targets} and in what order, then wait for my yes before drafting anything with libi.post_piece.`;
    case "bulk":
      return `Set up a recurring schedule for my posts on ${targets}: propose slots (or use Zernio's queue), show me the plan, and only create Zernio drafts after I confirm.`;
    case "ads":
      return `Boost ${ctx.postId ? `Zernio post ${ctx.postId}` : "this post"} as an ad. Before creating anything, state the ad network, the budget amount and type, the dates and the audience, and wait for my explicit yes. Then create it with your zernio tools and report the campaign id and review status.`;
    case "analytics":
      return `Read the analytics for ${ctx.postId ? `Zernio post ${ctx.postId}` : piece} (and the other recent posts if useful) and tell me what worked, what did not, and what to change next time. Numbers first, then two or three concrete suggestions.`;
  }
}
