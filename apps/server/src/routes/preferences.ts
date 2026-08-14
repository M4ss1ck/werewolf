import { Hono } from "hono";
import { z } from "zod";

const schema = z.object({ locale: z.enum(["en", "es"]) });
export function preferenceRoutes() {
  const app = new Hono();
  app.patch("/me/locale", async (c) => {
    const parsed = schema.safeParse(await c.req.json());
    if (!parsed.success) return c.json({ error: { code: "VALIDATION" } }, 400);
    return c.json(parsed.data);
  });
  return app;
}
