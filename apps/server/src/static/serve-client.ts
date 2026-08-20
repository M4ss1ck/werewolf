import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

import type { Hono } from "hono";

// The React build lives next to the server inside the production image, and at
// ../../client/dist when running from the repo.
const CANDIDATE_ROOTS = [
  resolve(import.meta.dir, "../../public"),
  resolve(import.meta.dir, "../../../client/dist"),
];

const clientRoot = CANDIDATE_ROOTS.find((dir) => existsSync(join(dir, "index.html")));

// The Telegram bot reuses this root to find the app icon; null when no client
// build exists, in which case the bot falls back to a text-only reply.
export const clientAssetRoot = clientRoot;

export function serveClient(app: Hono) {
  if (!clientRoot) return;

  const root = clientRoot;
  const indexHtml = join(root, "index.html");

  app.get("*", async (c) => {
    const path = new URL(c.req.url).pathname;

    if (path.startsWith("/api/")) {
      return c.notFound();
    }

    const asset = Bun.file(join(root, path));

    if (path !== "/" && (await asset.exists())) {
      return new Response(asset);
    }

    return new Response(Bun.file(indexHtml), {
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  });
}
