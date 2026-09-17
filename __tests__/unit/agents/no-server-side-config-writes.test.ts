import { describe, it, expect } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

/**
 * AGENTS.md: the studio server, its MCP children, its API routes and the
 * desktop shell never write an agent's config. The one writer is the
 * `libi connect` CLI (lib/cli/), which the user runs from their own terminal;
 * the Agents page only PRINTS the commands `lib/agents/setup/commands.ts`
 * builds.
 *
 * Each pin closes a different way a writer could come back:
 *  - importing the CLI's runner. A deleted route did exactly that, splitting
 *    its argv out of a catalog command string, so no argv regex ever saw it;
 *  - the print-only builder quietly gaining a way to spawn;
 *  - an `mcp add` / `mcp remove` argv, however it is laid out.
 *
 * The scan walks what is on DISK, not `git ls-files`, so a new file is covered
 * before it is ever staged.
 */
const ROOTS = ["app", "lib", "mcp", "electron", "bin"];
const SOURCE = /\.(?:[cm]?[jt]s|[jt]sx)$/;
/** Builds argv only to PRINT it into a setup terminal — it never spawns anything. */
const PRINT_ONLY = "lib/agents/setup/commands.ts";

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (SOURCE.test(entry.name)) out.push(full.split(path.sep).join("/"));
  }
  return out;
}

/** An import / re-export / dynamic import / require of `specifier`. */
const importOf = (specifier: string) =>
  new RegExp(`(?:\\bfrom\\s*|\\bimport\\s*\\(?\\s*|\\brequire\\s*\\(\\s*)["'\`]${specifier}["'\`]`);

// `@/lib/cli/connect`, `../cli/connect-command`, `../../lib/cli/connect.ts`, …
// `@/lib/cli/serve-mcp` (mcp/index.ts's entry point) is a different module and
// deliberately does not match — it registers nothing with any agent.
const IMPORTS_CONNECT = importOf(`[^"'\`\\n]*\\bcli\\/connect(?:-command)?(?:\\.[cm]?[jt]s)?`);
const IMPORTS_SPAWNER = importOf(
  `(?:(?:node:)?child_process|[^"'\`\\n]*node-pty[^"'\`\\n]*|execa|cross-spawn)`,
);

/**
 * True when `text` has a VALUE import (static or dynamic) of `specifierPattern` —
 * i.e. `import type { X } from "…"` / `export type { X } from "…"` do not count,
 * but a mixed `import { type X, realThing } from "…"` does, because it also pulls
 * in a value. Walking statements (rather than one `from`-anchored regex) is what
 * lets a type-only import through: `lib/agents/cli/resolve.ts` imports
 * `SetupAgentId` from the setup builder for its type only, and must stay clean.
 *
 * The `[^;]*` between the keyword and `from` deliberately allows newlines — a
 * named import list broken across lines (this codebase's default style, e.g.
 * `lib/mcp-config.ts:36`, `lib/music/generate.ts:8`) is a statement like any
 * other. `;` is still a hard statement boundary, so this never bridges two
 * unrelated imports together as long as the statement it should stop at is
 * itself terminated — true throughout this semicolon-using repo. It stays
 * linear time: no adjacent quantifier over an overlapping character class, so
 * there is nothing for backtracking to explore.
 */
function importsValue(text: string, specifierPattern: string): boolean {
  const dynamicOrRequire = new RegExp(
    `(?:\\bimport\\s*\\(\\s*|\\brequire\\s*\\(\\s*)["'\`]${specifierPattern}["'\`]`,
  );
  if (dynamicOrRequire.test(text)) return true;
  const staticImport = new RegExp(
    `\\b(?:import|export)\\b[^;]*\\bfrom\\s*["'\`]${specifierPattern}["'\`]`,
    "g",
  );
  for (const m of text.matchAll(staticImport)) {
    const statement = m[0];
    // A whole-clause `import type { … }` / `export type { … }` imports no value.
    if (/^\s*(?:import|export)\s+type\b/.test(statement)) continue;
    // A named list (`{ … }`) where every specifier is individually `type`-qualified
    // — `import { type X } from "…"`, `import { type X, type Y } from "…"` — also
    // imports no value, even though the clause itself isn't `import type`. A mixed
    // list (`{ type X, real }`) still does, because `real` is a value.
    const namedList = statement.match(/\{([^{}]*)\}/);
    if (namedList) {
      const specifiers = namedList[1]
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      if (specifiers.length > 0 && specifiers.every((s) => /^type\s/.test(s))) continue;
    }
    return true;
  }
  return false;
}

// The print-only setup-command builder and the provider catalog it reads. A file
// that can already spawn (matches IMPORTS_SPAWNER) and also pulls a real value out
// of either is a writer waiting to happen — see the "the print-only builder
// quietly gaining a way to spawn" case in the header comment.
const SETUP_COMMANDS_SPEC = `[^"'\`\\n]*\\bagents\\/setup\\/commands(?:\\.[cm]?[jt]s)?`;
const PROVIDER_CATALOG_SPEC = `[^"'\`\\n]*\\bproviders\\/catalog(?:\\.[cm]?[jt]s)?`;

const Q = `["'\`]`;
/** `[` then any number of leading elements (spread, an identifier, a literal — anything
 *  that isn't a comma or `]`), then `"mcp",` — across lines. Deliberately not limited to
 *  `...spread` so `[nodeBin, "mcp", "add", …]` (the node-script spawn shape) is caught too.
 *  The trailing whitespace sits OUTSIDE the repeated group, not glued to each element's
 *  `,` — a `[^,\]]+` element immediately followed by its own `,\s*` is the classic
 *  catastrophic-backtracking shape (the element class and the whitespace class both admit
 *  spaces, so a run of them can split between "this element" and "the next one's leading
 *  whitespace" in exponentially many equivalent ways once the whole thing fails to find
 *  `mcp`). It hung for real against `lib/ai/scene-validator.ts`'s denylist array before
 *  this rewrite — that file, not a contrived one, is why this note exists. */
const ARGV_HEAD = `\\[\\s*(?:[^,\\]]+,)*\\s*${Q}mcp${Q}\\s*,\\s*`;
// `add-json` is a real Claude subcommand that writes config exactly like `add`.
const SUBCOMMAND = `(?:add(?:-json)?|remove)`;
const ARGV_PATTERNS: Array<[string, RegExp]> = [
  ["literal `mcp add|add-json|remove` argv", new RegExp(`${ARGV_HEAD}${Q}${SUBCOMMAND}${Q}`)],
  // `["mcp", op]` — a subcommand chosen at runtime is a writer waiting to happen.
  ["`mcp` argv with a computed subcommand", new RegExp(`${ARGV_HEAD}[A-Za-z_$]`)],
  // `"codex mcp add fal-ai …".split(" ")`, or a template literal split the same way.
  [
    "`mcp add|add-json|remove` string split into argv",
    new RegExp(`${Q}[^"'\`\\n]*\\bmcp\\s+${SUBCOMMAND}\\b[^"'\`\\n]*${Q}\\s*\\.split\\s*\\(`),
  ],
];

// A quoted (or templated) string naming an `mcp add|add-json|remove` command, handed
// straight to something that runs a shell string rather than an argv array.
const MCP_COMMAND_STRING = `${Q}[^"'\`\\n]*\\bmcp\\s+${SUBCOMMAND}\\b`;
const COMMAND_STRING_PATTERNS: Array<[string, RegExp]> = [
  [
    "`mcp add|add-json|remove` string passed straight to exec/execSync",
    new RegExp(`\\b(?:exec|execSync)\\s*\\(\\s*${MCP_COMMAND_STRING}`),
  ],
  [
    "`mcp add|add-json|remove` string passed to spawn with a shell",
    new RegExp(`\\bspawn\\s*\\([^)]*\\bshell\\s*:\\s*true[^)]*${MCP_COMMAND_STRING}|\\bspawn\\s*\\(\\s*${MCP_COMMAND_STRING}[^)]*\\bshell\\s*:\\s*true`),
  ],
];

describe("no server-side agent-config writes", () => {
  const all = ROOTS.flatMap((root) => walk(root));
  const outsideCli = all.filter((f) => !f.startsWith("lib/cli/"));
  const read = (f: string) => readFileSync(f, "utf8");

  it("scans the real tree (a broken walk must not pass vacuously)", () => {
    expect(all).toContain("app/api/providers/route.ts");
    expect(all).toContain(PRINT_ONLY);
    expect(all).toContain("mcp/index.ts");
    expect(all).toContain("lib/cli/connect-command.ts");
  });

  it("the import patterns recognise every spelling of an import, and nothing else", () => {
    for (const line of [
      `import { makeRun } from "@/lib/cli/connect-command";`,
      `export { runConnect } from '../cli/connect';`,
      `const { makeRun } = await import("../../../lib/cli/connect-command.ts");`,
      `const c = require("@/lib/cli/connect");`,
    ]) {
      expect(IMPORTS_CONNECT.test(line), line).toBe(true);
    }
    expect(IMPORTS_CONNECT.test(`import { serveMcp } from "@/lib/cli/serve-mcp";`)).toBe(false);
    expect(IMPORTS_CONNECT.test("// the only writer is `lib/cli/connect.ts`")).toBe(false);
    expect(IMPORTS_SPAWNER.test(`import { execFile } from "node:child_process";`)).toBe(true);
    expect(IMPORTS_SPAWNER.test(`import * as pty from "@homebridge/node-pty-prebuilt-multiarch";`)).toBe(true);
  });

  it("importsValue recognises a real import of the setup builder or catalog, and lets a type-only import through", () => {
    expect(
      importsValue(
        `import { connectLibiCommand } from "@/lib/agents/setup/commands";`,
        SETUP_COMMANDS_SPEC,
      ),
    ).toBe(true);
    expect(
      importsValue(
        `import { type SetupAgentId, connectLibiCommand } from "../../agents/setup/commands";`,
        SETUP_COMMANDS_SPEC,
      ),
    ).toBe(true);
    expect(
      importsValue(`const c = await import("@/lib/providers/catalog");`, PROVIDER_CATALOG_SPEC),
    ).toBe(true);
    expect(
      importsValue(`const c = require("../../lib/providers/catalog");`, PROVIDER_CATALOG_SPEC),
    ).toBe(true);
    // The one real spawner-adjacent file that imports the builder does so for a type only.
    expect(
      importsValue(
        `import type { SetupAgentId } from "@/lib/agents/setup/commands";`,
        SETUP_COMMANDS_SPEC,
      ),
    ).toBe(false);
  });

  it("importsValue sees a value import laid out across multiple lines, and still handles every named-import shape", () => {
    // (a) A multi-line named import — this codebase's own default style for a
    // list of more than one or two names (`lib/mcp-config.ts:36`,
    // `lib/music/generate.ts:8`) — must not slip past the pin.
    expect(
      importsValue(
        `import {\n  providerRemoveCommand,\n  providerAddCommand,\n} from "@/lib/agents/setup/commands";`,
        SETUP_COMMANDS_SPEC,
      ),
    ).toBe(true);
    // (b) A mixed type/value named import still counts as a value import.
    expect(
      importsValue(
        `import { type SetupAgentId, providerAddCommand } from "@/lib/agents/setup/commands";`,
        SETUP_COMMANDS_SPEC,
      ),
    ).toBe(true);
    // (c) A re-export is a value import of what it re-exports.
    expect(
      importsValue(
        `export { providerAddCommand } from "@/lib/agents/setup/commands";`,
        SETUP_COMMANDS_SPEC,
      ),
    ).toBe(true);
    // (d) A multi-line whole-clause type import stays excluded.
    expect(
      importsValue(
        `import type {\n  SetupAgentId,\n  LibiScope,\n} from "@/lib/agents/setup/commands";`,
        SETUP_COMMANDS_SPEC,
      ),
    ).toBe(false);
    // (e) A named import list where every specifier is individually `type`-qualified
    // imports no value, even though the clause itself isn't `import type`.
    expect(
      importsValue(
        `import { type SetupAgentId } from "@/lib/agents/setup/commands";`,
        SETUP_COMMANDS_SPEC,
      ),
    ).toBe(false);
    expect(
      importsValue(
        `import { type SetupAgentId, type LibiScope } from "@/lib/agents/setup/commands";`,
        SETUP_COMMANDS_SPEC,
      ),
    ).toBe(false);
  });

  it("the offenders scan catches a multi-line named import of the setup builder passed to a spawner", () => {
    // Reproduces the exact bypass this pin exists to close, inline rather than on
    // disk: a file that can already spawn, and separately imports the print-only
    // builder as a multi-line named import rather than a single-line one.
    const src =
      `import { exec } from "node:child_process";\n` +
      `import {\n  providerRemoveCommand,\n  providerAddCommand,\n} from "@/lib/agents/setup/commands";\n\n` +
      `export function doIt(id: string) {\n  exec(providerRemoveCommand(id));\n}\n`;
    expect(IMPORTS_SPAWNER.test(src)).toBe(true);
    expect(importsValue(src, SETUP_COMMANDS_SPEC)).toBe(true);
  });

  it("nothing outside lib/cli imports the connect CLI or its runner", () => {
    expect(outsideCli.filter((f) => IMPORTS_CONNECT.test(read(f)))).toEqual([]);
  });

  it("the print-only command builder cannot spawn anything", () => {
    expect(IMPORTS_SPAWNER.test(read(PRINT_ONLY))).toBe(false);
  });

  it("nothing outside lib/cli that can already spawn also value-imports the setup builder or provider catalog", () => {
    const offenders = outsideCli.filter((f) => {
      const src = read(f);
      if (f === PRINT_ONLY || !IMPORTS_SPAWNER.test(src)) return false;
      return importsValue(src, SETUP_COMMANDS_SPEC) || importsValue(src, PROVIDER_CATALOG_SPEC);
    });
    expect(offenders).toEqual([]);
  });

  it.each(ARGV_PATTERNS)("nothing outside lib/cli builds a %s", (_label, pattern) => {
    const offenders = outsideCli.filter((f) => f !== PRINT_ONLY && pattern.test(read(f)));
    expect(offenders).toEqual([]);
  });

  it.each(COMMAND_STRING_PATTERNS)("nothing outside lib/cli builds a %s", (_label, pattern) => {
    const offenders = outsideCli.filter((f) => f !== PRINT_ONLY && pattern.test(read(f)));
    expect(offenders).toEqual([]);
  });

  it("the argv patterns recognise the builder's own argv, so a writer shaped like it would be caught", () => {
    expect(ARGV_PATTERNS[0][1].test(read(PRINT_ONLY))).toBe(true);
  });

  it("the argv patterns recognise every realistic shape a regression could take", () => {
    // Non-spread, identifier-first argv — the node-script spawn shape.
    expect(
      ARGV_PATTERNS[0][1].test(`const argv = [nodeBin, "mcp", "add", "--transport", "http"];`),
    ).toBe(true);
    // `add-json` is a real Claude subcommand that writes config exactly like `add`.
    expect(ARGV_PATTERNS[0][1].test(`["mcp", "add-json", name, JSON.stringify(cfg)]`)).toBe(true);
    // A computed subcommand with a non-spread leading element.
    expect(ARGV_PATTERNS[1][1].test(`[cliPath, "mcp", op, name]`)).toBe(true);
  });

  it("the command-string patterns recognise every realistic shape a regression could take", () => {
    expect(
      COMMAND_STRING_PATTERNS[0][1].test(
        "exec(`${cli} mcp add --transport http libi ${url}`)",
      ),
    ).toBe(true);
    expect(COMMAND_STRING_PATTERNS[0][1].test(`exec("claude mcp remove libi")`)).toBe(true);
    expect(
      COMMAND_STRING_PATTERNS[0][1].test(`execSync("codex mcp add-json libi " + json)`),
    ).toBe(true);
    expect(
      COMMAND_STRING_PATTERNS[1][1].test(
        `spawn("claude mcp remove libi", { shell: true })`,
      ),
    ).toBe(true);
    // A builder-string held in a variable and exec'd untouched is not a literal command
    // string — that shape is caught by the import pin above, not this pattern.
    expect(COMMAND_STRING_PATTERNS[0][1].test(`exec(cmd);`)).toBe(false);
  });

  it("the deleted routes stay deleted", () => {
    for (const f of [
      "app/api/codex/connect/route.ts",
      "app/api/providers/connect/route.ts",
      "app/api/providers/remove/route.ts",
      "lib/codex-config/sync.ts",
      "lib/codex-config/migrate-legacy.ts",
      "lib/codex-config/managed-manifest.ts",
      "mcp/settings.ts",
    ]) {
      expect(existsSync(f), f).toBe(false);
    }
  });
});
