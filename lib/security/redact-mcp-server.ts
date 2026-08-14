/**
 * RC-F: MCP secret redaction for the settings API.
 *
 * `mcp_servers.envVars` stores a JSON object of `{ NAME: value }` API keys
 * (FAL_KEY, ELEVENLABS_API_KEY, custom tokens). `mcp_servers.headers` stores a
 * JSON object of `{ Header-Name: value }` for HTTP MCP servers — and those
 * values include `Authorization: Bearer <FAL_KEY>` bearer secrets. Neither the
 * envVars values NOR the header values must EVER reach the browser. The settings
 * API therefore serializes ONLY the NAMES via `configuredEnvVars` /
 * `configuredHeaders` — mirroring what `libi.list_bundled_mcps`
 * (`mcp/tools/mcp-status-tools.ts`) already does — and never echoes a value.
 */

/** Parse the value map from the stored envVars JSON. SERVER-SIDE ONLY — the
 * returned values are plaintext secrets and must never be serialized to a
 * client response. Used for the server-side merge in PATCH. */
export function parseEnvVarsMap(envVarsJson: string | null | undefined): Record<string, string> {
  if (!envVarsJson) return {};
  try {
    const parsed = JSON.parse(envVarsJson) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object") return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === "string") out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

/** The NAMES of env vars that have a non-empty configured value. Safe to send
 * to the client. */
export function parseConfiguredEnvVarNames(envVarsJson: string | null | undefined): string[] {
  const map = parseEnvVarsMap(envVarsJson);
  return Object.keys(map).filter((k) => map[k] !== undefined && map[k] !== "");
}

/**
 * Merge an incoming partial env-var map into the existing stored map.
 * A blank / whitespace-only incoming value means "leave the stored value
 * unchanged" — so a save that doesn't retype an existing secret can never
 * wipe it. Non-empty incoming values add or replace a key.
 */
export function mergeEnvVars(
  existingJson: string | null | undefined,
  incoming: Record<string, string> | null | undefined,
): Record<string, string> {
  const merged = parseEnvVarsMap(existingJson);
  if (!incoming) return merged;
  for (const [k, v] of Object.entries(incoming)) {
    if (typeof v === "string" && v.trim().length > 0) merged[k] = v;
    // blank/whitespace => leave the stored value untouched.
  }
  return merged;
}

/** The NAMES of headers that have a non-empty configured value. Safe to send
 * to the client (a header VALUE — e.g. a bearer token — is NEVER emitted). The
 * stored headers JSON is `{ Header-Name: value }`, same shape as envVars. */
export function parseConfiguredHeaderNames(headersJson: string | null | undefined): string[] {
  const map = parseEnvVarsMap(headersJson);
  return Object.keys(map).filter((k) => map[k] !== undefined && map[k] !== "");
}

/**
 * Merge an incoming partial headers map into the existing stored map. Same
 * semantics as {@link mergeEnvVars}: a blank / whitespace-only incoming value
 * means "leave the stored header unchanged" — so saving the form without
 * retyping an existing `Authorization` secret can never wipe it. Non-empty
 * incoming values add or replace a header.
 */
export function mergeHeaders(
  existingJson: string | null | undefined,
  incoming: Record<string, string> | null | undefined,
): Record<string, string> {
  return mergeEnvVars(existingJson, incoming);
}

/**
 * Strip the raw `envVars` AND `headers` values from a serialized MCP server row
 * and replace them with `configuredEnvVars` / `configuredHeaders` (the NAMES
 * only). Use this at EVERY API surface that returns an MCP server row (GET list,
 * PATCH, POST) so a plaintext secret — env-var value or bearer-token header —
 * never reaches the browser.
 */
export function redactServerRow<
  T extends { envVars?: string | null; headers?: string | null },
>(
  row: T,
): Omit<T, "envVars" | "headers"> & {
  configuredEnvVars: string[];
  configuredHeaders: string[];
} {
  const { envVars, headers, ...rest } = row;
  return {
    ...(rest as Omit<T, "envVars" | "headers">),
    configuredEnvVars: parseConfiguredEnvVarNames(envVars ?? null),
    configuredHeaders: parseConfiguredHeaderNames(headers ?? null),
  };
}
