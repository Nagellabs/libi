import { defineConfig } from "drizzle-kit";
import { getLibiDbPath } from "./lib/libi-home";

export default defineConfig({
  schema: "./lib/db/schema/sqlite.ts",
  out: "./drizzle/sqlite",
  dialect: "sqlite",
  dbCredentials: {
    url: process.env.DB_PATH || getLibiDbPath(),
  },
});
