import { serve } from "@hono/node-server";

import { createApp } from "./app.js";
import { db } from "./db/index.js";
import { attachWebSocket, startChangeListener } from "./ws.js";

const app = createApp(db);
const { injectWebSocket, broadcastInvalidate } = attachWebSocket(app);

const port = Number(process.env.PORT ?? 3010);

const server = serve({ fetch: app.fetch, port }, (info) => {
  console.log(`[server] listening on http://127.0.0.1:${info.port}`);
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
