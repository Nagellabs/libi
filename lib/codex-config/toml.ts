/**
 * Minimal TOML emitter for the limited shape Codex needs.
 *
 * Only supports what `~/.codex/config.toml`'s `[mcp_servers.<name>]` tables
 * require: string values, arrays of strings, and inline tables for `env`.
 * No nested arrays-of-tables, no datetime, no float — anything outside this
 * shape throws so callers can't silently emit invalid TOML.
 */

export function escapeString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function emitString(value: string): string {
  return `"${escapeString(value)}"`;
}

function emitArray(values: string[]): string {
  return `[${values.map(emitString).join(", ")}]`;
}

function emitInlineTable(values: Record<string, string>): string {
  const entries = Object.entries(values).map(([k, v]) => `${k} = ${emitString(v)}`);
  return `{ ${entries.join(", ")} }`;
}

/**
 * Emit a bare TOML value literal (string, array-of-strings, or inline table)
 * — no key, no assignment. Reused by the inline `-c` args builder to render
 * the right-hand side of `mcp_servers.<name>.<key>=<value>` overrides.
 */
export function tomlEmitValue(
  value: string | string[] | Record<string, string>,
): string {
  return emitValue(value);
}

function emitValue(value: string | string[] | Record<string, string>): string {
  if (typeof value === "string") return emitString(value);
  if (Array.isArray(value)) return emitArray(value);
  if (value && typeof value === "object") return emitInlineTable(value);
  throw new Error(`tomlEmit: unsupported value type ${typeof value}`);
}

/**
 * Render a `[mcp_servers.<name>]` table with the given fields.
 *
 * Field order is preserved from `Object.entries` so callers can write
 * `command` before `args` before `env` for human-readability. The table
 * header is bracket-quoted using TOML bare-key rules when safe and a
 * quoted key otherwise — MCP names can contain `-` and `_` (bare-safe);
 * anything else gets quoted defensively.
 */
/**
 * Render a single TOML key segment: bare when it matches the bare-key rule
 * (`[A-Za-z0-9_-]+`), quoted otherwise. Shared by the table header emitter and
 * the inline `-c` args builder so both quote MCP server names identically.
 */
export function tomlEmitKey(name: string): string {
  const bareKeyOk = /^[A-Za-z0-9_-]+$/.test(name);
  return bareKeyOk ? name : emitString(name);
}

export function tomlEmitServerTable(
  name: string,
  fields: Record<string, string | string[] | Record<string, string>>,
): string {
  const header = `[mcp_servers.${tomlEmitKey(name)}]`;

  const lines: string[] = [header];
  for (const [key, value] of Object.entries(fields)) {
    lines.push(`${key} = ${emitValue(value)}`);
  }
  return lines.join("\n");
}
