import { type Client, createClient } from "@libsql/client";
import { drizzle, type LibSQLDatabase } from "drizzle-orm/libsql";
import * as schema from "./schema.ts";

export type Db = LibSQLDatabase<typeof schema>;
export function createDb(url: string, authToken?: string): { client: Client; db: Db } {
  const client = createClient(authToken === undefined ? { url } : { url, authToken });
  return { client, db: drizzle(client, { schema }) };
}
