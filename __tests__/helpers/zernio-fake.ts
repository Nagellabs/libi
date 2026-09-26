/**
 * A STRICT test double of Zernio's hosted MCP.
 *
 * It exists because the permissive stub it replaces is what let three
 * breaking assumptions ship green: a `headers` argument the live tools reject
 * outright, a camelCase write body the live tools reject outright, and the
 * `{ "result": "<Python repr>" }` envelope every live answer arrives in. A
 * fake that accepts anything and answers plain JSON proves only that libi
 * talks to that fake.
 *
 * So this one does exactly two things the real server does:
 *
 *  1. **Validates arguments against the RECORDED `inputSchema`s**, all of
 *     which are `additionalProperties: false` (read off the live server on
 *     2026-09-20). An unknown argument fails the call the way the live server
 *     fails it, with its own text.
 *  2. **Answers in the fastmcp envelope** — the configured value is printed as
 *     a Python `repr` and wrapped in `{ result: … }`, then read back through
 *     the production seam (`parseZernioPayload`). Nothing here hands the
 *     adapter a pre-parsed object.
 *
 * It also LISTS only what the live server lists — the curated tools — while
 * serving the full-shaped ones through `call_tool`, and answers a name it
 * does not know with Zernio's own `Unknown tool: '…'`. A fake whose
 * `tools/list` advertised the full-shaped names is what hid the resolver
 * defect for two whole tasks.
 *
 * The HTTP fake test mode serves (`mcp/dev/fake-zernio/`) does all three
 * too, off the SAME recorded surface — see `live-surface.ts`.
 */
import { parseZernioPayload, toSocialError, type ProviderMcp } from "@/lib/social/mcp-client";
import {
  CURATED_TOOLS,
  FULL_SHAPED_TOOLS,
  LIVE_TOOLS,
  REACHABLE_TOOLS,
  ZERNIO_INPUT_SCHEMAS,
  pythonRepr,
  unknownToolText,
  validationErrorText,
} from "@/mcp/dev/fake-zernio/live-surface";

/**
 * The recorded live surface is shared with the HTTP fake test mode serves
 * (`mcp/dev/fake-zernio/`), NOT redeclared here: the two must answer the same
 * `tools/list`, reject the same arguments and speak the same envelope, or one
 * of them is proving something about itself rather than about Zernio.
 */
export {
  CURATED_TOOLS,
  FULL_SHAPED_TOOLS,
  LIVE_TOOLS,
  REACHABLE_TOOLS,
  ZERNIO_INPUT_SCHEMAS,
  pythonRepr,
  unknownToolText,
};

/**
 * The live rejection, routed through the production mapper exactly as
 * `parseResult` routes an `isError` tool result, so the adapter sees the kind
 * it would see live:
 *
 *     1 validation error for call[posts_create_post]
 *     headers  Unexpected keyword argument
 */
export function rejectUnknownArguments(name: string, args: Record<string, unknown>): void {
  const text = validationErrorText(name, args);
  if (text) throw toSocialError(new Error(text));
}

/**
 * An answer whose `result` string is used VERBATIM, rather than being printed
 * from a value. The one way to express what a prose-flattening convenience
 * tool really sends: `{ result: "Found 2 connected account(s): …" }`, an inner
 * string that is neither JSON nor a Python literal.
 */
export class RawZernioResult {
  constructor(readonly text: string) {}
}
export const rawZernioResult = (text: string): RawZernioResult => new RawZernioResult(text);

export type ZernioAnswer = unknown | ((args: Record<string, unknown>) => unknown);

export interface ZernioFake {
  mcp: ProviderMcp;
  /** `via` records HOW the name was dispatched — direct, or the `call_tool` hop. */
  calls: Array<{ name: string; args: Record<string, unknown>; via: "direct" | "call_tool" }>;
}

/**
 * A `ProviderMcp` over the recorded schemas and the real envelope. `answers`
 * maps a tool name to the value the server would return (the payload INSIDE
 * `result`), or to a function that computes it — or throws, for a failure.
 */
export function fakeZernioMcp(answers: Record<string, ZernioAnswer>, tools: string[] = LIVE_TOOLS): ZernioFake {
  const calls: Array<{ name: string; args: Record<string, unknown>; via: "direct" | "call_tool" }> = [];
  const mcp: ProviderMcp = {
    async listToolNames() {
      return tools;
    },
    async call<X>(name: string, args: Record<string, unknown>) {
      // The production client's own rule: a listed name goes direct, anything
      // else takes the `call_tool` hop (mcp-client.ts#call).
      const via = tools.includes(name) ? "direct" : "call_tool";
      calls.push({ name, args, via });
      if (via === "call_tool" && !tools.includes("call_tool")) {
        throw toSocialError(new Error(unknownToolText(name)));
      }
      rejectUnknownArguments(name, args);
      // A name nothing configured an answer for is unknown to this server, and
      // it says so the way Zernio says it — which is what rename recovery
      // keys on. A name that IS reachable but has no answer is the test's own
      // mistake, and stays a loud unexpected-call.
      if (!(name in answers)) {
        if (!REACHABLE_TOOLS.includes(name)) throw toSocialError(new Error(unknownToolText(name)));
        throw new Error(`unexpected call: ${name}`);
      }
      const answer = answers[name];
      const value = typeof answer === "function" ? (answer as (a: Record<string, unknown>) => unknown)(args) : answer;
      // The envelope, then the production seam that reads it. Nothing in a
      // test may skip this: reading it is the thing being proven.
      const inner = value instanceof RawZernioResult ? value.text : pythonRepr(value);
      return parseZernioPayload({ result: inner }, name) as X;
    },
    async close() {},
  };
  return { mcp, calls };
}
