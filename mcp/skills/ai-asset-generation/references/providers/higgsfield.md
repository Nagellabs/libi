# higgsfield — provider reference for `ai-asset-generation`

Read this when your `image` / `video` provider is Higgsfield. It holds only what is confirmed
about Higgsfield's hosted MCP server. Which tools it has, which models, and their parameters
come from the server itself, in your tool list. The capability rules, the universal video
invariants and the import/provenance mechanics stay in `SKILL.md`; the call discipline every
provider shares (the `libi.sleep` polling cadence, a failed job's error shown verbatim) is
`ai-asset-generation`'s `references/providers/fal.md`. Follow both.

## The server

- Higgsfield's hosted MCP server, over HTTP: `https://mcp.higgsfield.ai/mcp`.
- **No API key.** The user signs in with their own Higgsfield account in the browser (OAuth),
  and their agent keeps that sign-in; libi never sees it. Never ask for a Higgsfield key.
  Source: https://higgsfield.ai/mcp ("Do I need an API key?").
- **The tools appear only after sign-in.** An entry that is added but not signed in gives you
  no Higgsfield tools: Claude Code lists it as needing authentication in `/mcp`, and Codex's
  `codex mcp list` reports it `not_logged_in`. Never guess a Higgsfield tool or model name; use
  what your tool list shows, and if it shows none, the user still has to sign in.

## Cost

Every generation spends the user's own Higgsfield plan credits, and the amount depends on the
model and the resolution. Source: https://higgsfield.ai/mcp ("How does pricing work?").

Before the first generation, tell the user it spends their Higgsfield credits and that the
cost depends on the model and resolution, and wait for a yes (SKILL.md Step 5). Quote a number
only when a Higgsfield tool gave you one; never invent a price.

## Adding, signing in and removing

libi never runs these, and neither do you. In the app, `libi.suggest_provider` puts a card in
the chat that opens the Agents page, where each Providers-tab button types the command for the
user to submit. Outside the app, relay these verbatim. A server added or signed in to is picked
up only by a NEW session.

| | Claude Code | Codex |
|---|---|---|
| Add | `claude mcp add --transport http --scope user higgsfield https://mcp.higgsfield.ai/mcp`, then sign in | `codex mcp add higgsfield --url https://mcp.higgsfield.ai/mcp` (starts the browser sign-in and waits until it ends) |
| Sign in | `claude mcp login higgsfield` in an interactive terminal, or `/mcp` in Claude Code, choose higgsfield, then Authenticate | `codex mcp login higgsfield` |
| Remove | `claude mcp logout higgsfield`, then `claude mcp remove --scope user higgsfield` | `codex mcp logout higgsfield`, then `codex mcp remove higgsfield` |

Sign out before removing: both agents look the stored sign-in up through the entry, and once
the entry is gone `mcp logout` has nothing to find.

## Provenance

Fill SKILL.md Step 9's `aiGeneration` with `provider: "higgsfield"` (the catalog id) and
`model` exactly as the Higgsfield tool named it. Add `costEstimate` only with an amount a
Higgsfield tool returned.
