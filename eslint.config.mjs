import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Electron
    "dist-electron/**",
    "release/**",
    // Compiled CLI/MCP output (scripts/build-cli.js) — generated, never edited.
    "dist-cli/**",
    // Git worktrees live under .claude/worktrees/<name>/ — full checkouts
    // with their own copy of everything. Linting them here quadruples the
    // file count and reports every finding twice (or stale, for a worktree
    // pinned to an older commit); each worktree lints itself.
    ".claude/**",
    // The tracking sidecar's Python virtualenv (created at install time,
    // gitignored) vendors matplotlib/torch JS assets. ESLint does not read
    // .gitignore, so without this it lints third-party minified JS.
    "**/.venv/**",
  ]),
  // Plain-JS Node tooling (scripts/, bin/, config files) is CommonJS by
  // construction — `require()` IS its import syntax, not a style violation.
  // The no-require-imports rule earns its keep in the TS source tree, where
  // a require() usually means someone is fighting the bundler.
  {
    files: ["**/*.js", "**/*.cjs"],
    rules: {
      "@typescript-eslint/no-require-imports": "off",
    },
  },
  // ── `import.meta` is banned in the compiled entry chains ────────────────
  // `lib/` and `mcp/` are compiled to CommonJS by `scripts/build-cli.js` for
  // the npm-installed run mode (tsx refuses to apply tsconfig `paths` to any
  // file under node_modules, so `npx @nagellabs/libi` cannot run from source).
  //
  // `import.meta` is ESM-only. tsx's hybrid shim makes `import.meta`,
  // `__dirname`, `require` and `module` ALL work in the same file — which real
  // Node never does — so this inconsistency is invisible at dev time. Compiled
  // to CJS, esbuild emits a WARNING (not an error) and substitutes `{}`, so
  // `fileURLToPath(import.meta.url)` becomes `fileURLToPath(undefined)` and
  // throws at module load: the MCP child dies on startup. That exact bug
  // shipped once, in mcp/bundled-mcps/install-tools.ts.
  //
  // Use `__dirname`, or `packageRoot()` from `lib/runtime/package-root.ts`
  // when you need the package root (depth-independent, so it is also correct
  // from the compiled `dist-cli/` mirror).
  //
  // This rule has NO CI enforcement of its own — `.github/workflows/` only
  // runs `license-check.yml`, and `npm run lint` is not wired into any
  // automatic gate. Don't assume a lint failure here blocks a merge; it
  // doesn't. The REAL, CI-reaching gate is `scripts/build-cli.js`, which
  // promotes esbuild's `empty-import-meta` warning to a hard build failure —
  // that step runs from `prepack` (fired on every `npm pack`/`npm publish`)
  // and from `scripts/next-build-release.js`, so a contributor who never runs
  // lint still can't ship an `import.meta` in these two directories. This
  // rule exists purely to catch it EARLIER, in the editor, for anyone who
  // does run lint.
  {
    files: ["lib/**/*.ts", "lib/**/*.tsx", "mcp/**/*.ts", "mcp/**/*.tsx"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: "MetaProperty[meta.name='import'][property.name='meta']",
          message:
            "`import.meta` is ESM-only and lib/ + mcp/ are compiled to CommonJS for `npx @nagellabs/libi` " +
            "(scripts/build-cli.js). It compiles to `{}` and crashes the module at load time. " +
            "Use `__dirname`, or `packageRoot()` from @/lib/runtime/package-root.",
        },
      ],
    },
  },
  // ── AGENTS.md: server / MCP / agent / session / lifecycle code goes
  // through `serverLogger` / `mcpLogger` (`lib/logger.ts`), never `console.*`.
  // A raw console write in these paths either corrupts MCP stdio JSON-RPC
  // (stdout is a wire protocol there) or is invisible to `~/.libi/logs/libi.log`,
  // the one place a running instance's behavior can actually be grepped.
  // No console method is exempt by default — ESLint's `allow` option rejects
  // an explicit empty array (`allow: []` fails schema validation as "fewer
  // than 1 items"), so the equivalent "nothing allowed" form is simply the
  // bare rule with no options. A genuine need (e.g. deliberately writing to
  // stderr so stdout stays clean for JSON-RPC) gets a scoped override below,
  // not a blanket allowance here.
  {
    files: [
      "app/api/**/*.ts",
      "app/api/**/*.tsx",
      "lib/server/**/*.ts",
      "lib/agents/**/*.ts",
      "lib/sessions/**/*.ts",
      "lib/db/**/*.ts",
      "lib/dev/**/*.ts",
      "mcp/**/*.ts",
    ],
    rules: {
      "no-console": "error",
    },
  },
  // `lib/db/client.ts` backup/prune logging deliberately writes to STDERR via
  // `console.error`/`console.warn`, not `serverLogger`. This module also runs
  // inside the MCP stdio child process, where stdout is reserved for JSON-RPC
  // — routing these through the pino logger is fine today, but a raw
  // `console.error`/`console.warn` call is the one construct that is
  // *structurally* incapable of ever regressing onto stdout, which is why the
  // inline comments at each call site ask for it to stay this way. See
  // `pruneBackups`/`backupDb` in that file for the full reasoning.
  {
    files: ["lib/db/client.ts"],
    rules: {
      "no-console": ["error", { allow: ["error", "warn"] }],
    },
  },
]);

export default eslintConfig;
