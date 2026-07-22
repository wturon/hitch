import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dbCredentials: {
    // Only needed for `db:migrate` / introspection — `db:generate` is offline.
    url: process.env.DATABASE_URL ?? "postgres://localhost:5432/hitch",
  },
});
