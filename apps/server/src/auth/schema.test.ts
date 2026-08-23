import { describe, expect, test } from "bun:test";
import { createAuthTables } from "./schema.ts";

// A hosted Turso database is reached over hrana HTTP, which maps every SQLite
// error to SQLITE_UNKNOWN. The local file: client reports SQLITE_ERROR for the
// same failure, so a code list drawn from local runs passes the gate and then
// crashes the deployment on its second boot.
function hranaError(message: string) {
  return Object.assign(new Error(`SQLITE_UNKNOWN: SQLite error: ${message}`), {
    code: "SQLITE_UNKNOWN",
  });
}

function stubClient(onAlter: (sql: string) => void) {
  const executed: string[] = [];
  return {
    executed,
    executeMultiple: async (sql: string) => {
      executed.push(sql);
      if (sql.includes("ADD COLUMN")) onAlter(sql);
    },
    execute: async () => ({ rows: [] }),
  };
}

describe("createAuthTables", () => {
  test("treats a hosted-Turso duplicate column as already applied", async () => {
    const client = stubClient((sql) => {
      throw hranaError(
        `duplicate column name: ${sql.includes("usernameSearch") ? "usernameSearch" : "username"}`,
      );
    });

    await createAuthTables(client);

    expect(client.executed.some((sql) => sql.includes("user_username_search_idx"))).toBe(true);
  });

  test("still propagates an error that is not a duplicate column", async () => {
    const client = stubClient(() => {
      throw hranaError("no such table: user");
    });

    await expect(createAuthTables(client)).rejects.toThrow("no such table");
  });
});
