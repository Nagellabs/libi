import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["__tests__/**/*.test.ts", "__tests__/**/*.test.tsx"],
    // Globally isolate LIBI_HOME for the whole run so tests can't write to
    // the user's real `~/.libi/`. invalidateMcpConfig/prepareAgentDir
    // resolve the agent dir from LIBI_HOME, so isolating the home is
    // sufficient. LIBI_CONNECT_AGENT_DIR is never set globally.
    globalSetup: ["./__tests__/setup/isolate-libi-home.ts"],
    coverage: {
      provider: "v8",
      include: ["lib/**/*.ts"],
      exclude: ["lib/**/types.ts", "lib/**/index.ts"],
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "."),
    },
  },
});
