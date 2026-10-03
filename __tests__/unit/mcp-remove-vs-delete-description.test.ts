/**
 * Pins the Remove-vs-Delete semantic into the tool descriptions agents
 * see at session start. If someone "cleans up" the wording and drops the
 * distinction, this catches it.
 */
import { describe, it, expect } from "vitest";
import { listLibiTools } from "./../helpers/tool-surface";

describe("MCP tool descriptions enforce Remove-vs-Delete", () => {
  it("audio_clip's remove action says the file is NOT deleted", async () => {
    const tool = (await listLibiTools()).find((t) => t.name === "libi.audio_clip");
    expect(tool).toBeTruthy();
    const action = (tool!.inputSchema as { properties: { action: { description: string } } }).properties.action.description;
    const remove = action.split("; ").find((p) => p.startsWith("remove = "));
    expect(remove).toBeTruthy();
    expect(remove).toMatch(/NOT deleted/i);
    expect(remove).toMatch(/stays in resources/i);
  });
});
