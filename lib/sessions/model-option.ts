import type {
  SessionConfigOption,
  SessionConfigSelectOption,
  SessionConfigSelectGroup,
} from "@agentclientprotocol/sdk";

/** ACP config-option id that both claude-agent-acp and codex-acp use for the model select. */
export const MODEL_CONFIG_ID = "model";

export interface ModelChoice {
  id: string;
  name: string;
  description?: string;
}

export interface ModelState {
  currentModelId: string;
  availableModels: ModelChoice[];
}

function isGroup(
  o: SessionConfigSelectOption | SessionConfigSelectGroup,
): o is SessionConfigSelectGroup {
  return "options" in o && Array.isArray((o as SessionConfigSelectGroup).options);
}

function toChoice(o: SessionConfigSelectOption): ModelChoice {
  return { id: o.value, name: o.name, description: o.description ?? undefined };
}

/**
 * Pull the model state out of a session's ACP config options. Returns null when
 * the session advertises no `model` select (→ the UI hides the picker).
 * Preserves adapter-provided order and flattens grouped option lists.
 */
export function extractModelOption(
  configOptions: SessionConfigOption[] | null | undefined,
): ModelState | null {
  if (!configOptions || configOptions.length === 0) return null;
  const opt = configOptions.find((o) => o.id === MODEL_CONFIG_ID);
  if (!opt || opt.type !== "select") return null;

  const options = opt.options as Array<
    SessionConfigSelectOption | SessionConfigSelectGroup
  >;
  const availableModels = options.flatMap((o) =>
    isGroup(o) ? o.options.map(toChoice) : [toChoice(o)],
  );

  return { currentModelId: opt.currentValue, availableModels };
}

/**
 * Explicit prettified labels for model ids whose default transform below would
 * mangle them. Keep this SMALL — only entries the generic prettifier gets
 * wrong. Codex-acp advertises no leading "<Name> <version>" description token,
 * so its ids fall through to `prettifyModelId`.
 */
const MODEL_ID_LABELS: Record<string, string> = {
  // Generic gpt-family transform would title-case "codex" to a separate token
  // and produce "GPT-5-Codex"; the intended label uses a space.
  "gpt-5-codex": "GPT-5 Codex",
};

/**
 * Turn a recognized codex-family model id (e.g. "gpt-5.5") into a display label
 * ("GPT-5.5"). Table first; then a generic token transform for `gpt-*` ids:
 * split on "-", uppercase the "gpt" segment, title-case plain alphabetic tokens
 * ("codex" → "Codex"), and leave version-ish tokens (containing a digit)
 * untouched. Any id we DON'T recognize as a codex family is returned verbatim,
 * preserving the "fall back to id" behavior for arbitrary ids ("raw-id").
 */
function prettifyModelId(id: string): string {
  const known = MODEL_ID_LABELS[id];
  if (known) return known;
  const tokens = id.split("-");
  const isGptFamily = tokens[0]?.toLowerCase() === "gpt";
  if (!isGptFamily) return id;
  return tokens
    .map((token) => {
      if (token.length === 0) return token;
      if (token.toLowerCase() === "gpt") return "GPT";
      // Version-ish tokens (contain a digit) stay verbatim: "5.5", "4o".
      if (/\d/.test(token)) return token;
      // Plain word: title-case.
      return token.charAt(0).toUpperCase() + token.slice(1);
    })
    .join("-");
}

/**
 * Short, versioned label for the picker TRIGGER pill — e.g. "Opus 4.8",
 * "Sonnet 4.6", "Fable 5", "Haiku 4.5". The adapter puts the versioned model
 * name at the START of the description ("Opus 4.8 with 1M context · …",
 * "Sonnet 4.6 · …"), so we extract the leading "<Name> <version>" token. This
 * deliberately differs from the dropdown rows, which show the friendlier
 * `name` ("Default (recommended)", "Sonnet", …).
 *
 * Codex adapters advertise no such description prefix, so we fall back to
 * `name` (when present) and otherwise prettify the raw `id` via
 * `prettifyModelId` ("gpt-5-codex" → "GPT-5 Codex", "gpt-5.5" → "GPT-5.5").
 */
export function modelDisplayLabel(model: ModelChoice): string {
  const versioned = model.description?.match(/^[A-Za-z][\w-]*\s+\d+(?:\.\d+)?/);
  if (versioned) return versioned[0];
  if (model.name) return model.name;
  return prettifyModelId(model.id);
}
