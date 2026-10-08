import { defineConfig } from "drizzle-kit";

// Generates SQL migrations into ./drizzle from the schema; they are applied on startup.
export default defineConfig({
  dialect: "sqlite",
  schema: "./src/db/schema.ts",
  out: "./drizzle",
});
