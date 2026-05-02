import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "sqlite",
  schema: "./workers/db/control-plane/schema.ts",
  out: "./workers/db/control-plane/migrations",
  // For local migration generation. Production migrations are applied via
  // `wrangler d1 migrations apply DB --remote`.
  driver: "d1-http",
  dbCredentials: {
    accountId: process.env.CLOUDFLARE_ACCOUNT_ID || "local",
    databaseId: process.env.CLOUDFLARE_D1_DATABASE_ID || "local",
    token: process.env.CLOUDFLARE_D1_TOKEN || "local",
  },
  verbose: true,
  strict: true,
});
