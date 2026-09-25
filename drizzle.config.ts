import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "sqlite",
  schema: "./src/adapters/storage/schema.ts",
  out: "./drizzle",
});
