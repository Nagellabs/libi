import { describe, it, expect } from "vitest";
import { askAgentPrompt } from "@/lib/social/prompts";

describe("askAgentPrompt", () => {
  it("caption: names the piece and both platforms, asks for a caption only", () => {
    const p = askAgentPrompt("caption", { pieceId: "p1", pieceName: "Cutdown v3", targets: ["instagram", "tiktok"] });
    expect(p).toContain("p1");
    expect(p).toContain("Cutdown v3");
    expect(p).toContain("instagram");
    expect(p).toContain("tiktok");
    expect(p).toMatch(/caption only/);
    expect(p).toMatch(/do not post anything/i);
  });

  it("ads: tells the agent to state the budget and get a yes before creating anything", () => {
    const p = askAgentPrompt("ads", { postId: "post_1" });
    expect(p).toContain("post_1");
    expect(p).toMatch(/budget/i);
    expect(p).toMatch(/wait for my explicit yes/i);
  });

  it("ads: creation instruction comes after the yes is requested", () => {
    const p = askAgentPrompt("ads", { postId: "post_1" });
    const yesIdx = p.indexOf("wait for my explicit yes");
    const createIdx = p.indexOf("create it with your zernio tools");
    expect(yesIdx).toBeGreaterThan(-1);
    expect(createIdx).toBeGreaterThan(yesIdx);
  });

  it("post: says to use libi.post_piece and to leave it as a draft", () => {
    const p = askAgentPrompt("post", { pieceId: "p1" });
    expect(p).toContain("libi.post_piece");
    expect(p).toMatch(/leave it as a zernio draft/i);
    expect(p).toMatch(/do not schedule or publish/i);
  });

  it("falls back to a neutral piece/target phrase when no context is given", () => {
    const p = askAgentPrompt("decide", {});
    expect(p).toContain("the current piece");
    expect(p).toContain("the accounts I connected");
  });
});
