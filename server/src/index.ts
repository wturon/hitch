import { serve } from "@hono/node-server";

import { app } from "./app.js";

const port = Number(process.env.PORT ?? 3010);

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`[server] listening on http://127.0.0.1:${info.port}`);
});
