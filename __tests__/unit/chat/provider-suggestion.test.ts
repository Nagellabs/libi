import { describe, it, expect } from "vitest";
import {
  extractProviderSuggestion,
  isSuggestProviderCall,
  suggestionHref,
} from "@/lib/chat/provider-suggestion";

const call = { toolId: "libi:libi.suggest_provider", rawTitle: "mcp__libi__libi_suggest_provider" };
// The shape `mcp/tools/provider-tools.ts#suggestProvider` returns in-app.
const card = {
  status: "card",
  kind: "music",
  connected: [],
  covered: [],
  suggested: [
    { id: "ace-step", name: "ACE-Step (on-device music)", kinds: ["music"], kind: "extension", extensionId: "local-music", sizeNote: "~8.3 GB" },
    { id: "elevenlabs", name: "ElevenLabs", kinds: ["voice", "music", "sfx"], kind: "remote-mcp" },
  ],
  note: "A card with one button per suggestion is now in the chat.",
};

describe("provider-suggestion", () => {
  it("recognises the call by toolId or rawTitle (same rule as show_in_chat)", () => {
    expect(isSuggestProviderCall(call)).toBe(true);
    expect(isSuggestProviderCall({ toolId: null, rawTitle: "mcp__libi__libi_suggest_provider" })).toBe(true);
    expect(isSuggestProviderCall({ toolId: "libi:libi.list_pieces", rawTitle: "x" })).toBe(false);
  });

  it("recognises a codex call by its canonical id, including the fallback entry name", () => {
    expect(isSuggestProviderCall({ toolId: "libi:libi.suggest_provider", rawTitle: "mcp.libi.libi.suggest_provider" })).toBe(true);
    // A codex title with no structured id beside it still resolves through the tool-id helper.
    expect(isSuggestProviderCall({ toolId: null, rawTitle: "mcp.libi-app.libi.suggest_provider" })).toBe(true);
  });

  it("trusts the canonical id over the title when both are present", () => {
    // A title is presentation; once the call carries a canonical id, that id decides.
    expect(isSuggestProviderCall({ toolId: "libi:libi.list_pieces", rawTitle: "mcp__libi__libi_suggest_provider" })).toBe(false);
    // A different server's tool of the same name is not libi's.
    expect(isSuggestProviderCall({ toolId: "someone-else:suggest_provider", rawTitle: null })).toBe(false);
    expect(isSuggestProviderCall({ toolId: null, rawTitle: "Suggest a provider" })).toBe(false);
    expect(isSuggestProviderCall({ toolId: null, rawTitle: null })).toBe(false);
  });

  it("extracts a card payload from the shapes the reducer stores (content array / object / JSON string / under data)", () => {
    const wrapped = { content: [{ type: "text", text: JSON.stringify({ success: true, data: card }) }] };
    expect(extractProviderSuggestion(call, { result: wrapped })?.suggested.map((s) => s.id)).toEqual(["ace-step", "elevenlabs"]);
    expect(extractProviderSuggestion(call, { result: { data: card } })?.kind).toBe("music");
    expect(extractProviderSuggestion(call, { result: JSON.stringify(card) })?.kind).toBe("music");
    expect(extractProviderSuggestion(call, { result: wrapped.content })?.kind).toBe("music");
  });

  it("keeps only the fields the card renders, and drops malformed suggestions", () => {
    const messy = {
      ...card,
      covered: [{ id: "kokoro", name: "Kokoro", via: "extension" }, { id: 7 }],
      suggested: [...card.suggested, { id: "x" }, null, { id: "y", name: "Y", kinds: [], kind: "carrier-pigeon" }],
    };
    const payload = extractProviderSuggestion(call, { result: { data: messy } });
    expect(payload).toEqual({
      kind: "music",
      suggested: [
        { id: "ace-step", name: "ACE-Step (on-device music)", kinds: ["music"], kind: "extension", extensionId: "local-music", sizeNote: "~8.3 GB" },
        { id: "elevenlabs", name: "ElevenLabs", kinds: ["voice", "music", "sfx"], kind: "remote-mcp" },
      ],
      covered: [{ id: "kokoro", name: "Kokoro", via: "extension" }],
    });
  });

  it("returns null before the result arrives, for a none/cli result, and for a different tool", () => {
    expect(extractProviderSuggestion(call, undefined)).toBeNull();
    expect(extractProviderSuggestion(call, { result: { data: { ...card, status: "none" } } })).toBeNull();
    expect(extractProviderSuggestion(call, { result: { data: { ...card, status: "cli" } } })).toBeNull();
    expect(extractProviderSuggestion({ toolId: "libi:libi.list_pieces" }, { result: { data: card } })).toBeNull();
  });

  it("returns null for an errored result and for a card with nothing to offer", () => {
    expect(extractProviderSuggestion(call, { result: { data: card }, success: false })).toBeNull();
    const toolError = { content: [{ type: "text", text: JSON.stringify({ success: false, error: "boom" }) }], isError: true };
    expect(extractProviderSuggestion(call, { result: toolError })).toBeNull();
    expect(extractProviderSuggestion(call, { result: { data: card, isError: true } })).toBeNull();
    expect(extractProviderSuggestion(call, { result: { content: [{ type: "text", text: "Error: kind must be one of …" }] } })).toBeNull();
    expect(extractProviderSuggestion(call, { result: { data: { ...card, suggested: [] } } })).toBeNull();
    expect(extractProviderSuggestion(call, { result: { data: { ...card, suggested: "fal" } } })).toBeNull();
  });

  it("routes on-device to the libi MCP tab and third-party to Providers, carrying from=<sessionId>", () => {
    expect(suggestionHref(card.suggested[0] as never, "sess-1")).toBe("/agents?tab=libi-mcp&extension=local-music&from=sess-1");
    expect(suggestionHref(card.suggested[1] as never, "sess-1")).toBe("/agents?tab=providers&provider=elevenlabs&from=sess-1");
    expect(suggestionHref(card.suggested[1] as never, null)).toBe("/agents?tab=providers&provider=elevenlabs");
  });

  it("encodes every value it puts in the URL", () => {
    expect(suggestionHref({ id: "a&b", name: "A", kinds: [], kind: "remote-mcp" }, "s 1/2")).toBe(
      "/agents?tab=providers&provider=a%26b&from=s%201%2F2",
    );
    // An extension without its own id falls back to the provider id, as the CLI URL does.
    expect(suggestionHref({ id: "kokoro", name: "Kokoro", kinds: ["voice"], kind: "extension" }, null)).toBe(
      "/agents?tab=libi-mcp&extension=kokoro",
    );
  });
});
