import { fileURLToPath } from "node:url";

import { serve } from "@hono/node-server";
import { migrate } from "drizzle-orm/node-postgres/migrator";

import { createApp } from "./app.js";
import { db } from "./db/index.js";
import { createStorage, storageConfigFromEnv } from "./storage.js";
import { attachWebSocket, startChangeListener } from "./ws.js";

// MIGRATE_ON_BOOT=1 runs the drizzle migrations before serving — same
// programmatic migrator the tests use. Default ON in the container (see
// server/Dockerfile); local dev keeps using `npm run db:migrate` explicitly.
if (process.env.MIGRATE_ON_BOOT === "1") {
  // ../drizzle resolves to server/drizzle from both dist/ and src/.
  const migrationsFolder = fileURLToPath(new URL("../drizzle", import.meta.url));
  await migrate(db, { migrationsFolder });
  console.log("[server] migrations applied");
}

const app = createApp(db, createStorage(storageConfigFromEnv()));
const { injectWebSocket, broadcastInvalidate } = attachWebSocket(app);

const port = Number(process.env.PORT ?? 3010);

const server = serve({ fetch: app.fetch, port, hostname: "0.0.0.0" }, (info) => {
  console.log(`[server] listening on http://0.0.0.0:${info.port}`);
});
injectWebSocket(server);

// DATABASE_URL is guaranteed set — db/index.js throws at import when it isn't.
const changeListener = startChangeListener({
  connectionString: process.env.DATABASE_URL as string,
  onChange: broadcastInvalidate,
});

const shutdown = () => {
  void changeListener.stop().finally(() => {
    server.close();
    process.exit(0);
  });
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
