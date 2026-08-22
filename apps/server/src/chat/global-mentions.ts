import type { Db } from "@werewolf/db";
import {
  type ChatContent,
  type MentionCandidate,
  normalizeMentionSearch,
  type UserId,
} from "@werewolf/protocol";
import { and, asc, inArray, isNotNull, ne, sql } from "drizzle-orm";
import { authUser } from "../auth/schema.ts";

type MentionSelectExecutor = Pick<Db, "select">;

export function escapeLikePrefix(value: string): string {
  return `${value.replace(/[\\%_]/g, (character) => `\\${character}`)}%`;
}

export async function findGlobalMentionCandidates(
  db: Db,
  viewerId: UserId,
  rawQuery: string,
): Promise<MentionCandidate[]> {
  const rows = await db
    .select({ userId: authUser.id, displayName: authUser.username })
    .from(authUser)
    .where(
      and(
        ne(authUser.id, viewerId),
        isNotNull(authUser.username),
        sql`${authUser.usernameSearch} LIKE ${escapeLikePrefix(normalizeMentionSearch(rawQuery))} ESCAPE '\\'`,
      ),
    )
    .orderBy(
      sql`CASE WHEN instr(${authUser.username}, ${rawQuery}) = 1 THEN 0 ELSE 1 END`,
      asc(authUser.usernameSearch),
      asc(authUser.id),
    )
    .limit(8);

  return rows.flatMap((row) =>
    row.displayName === null
      ? []
      : [{ userId: row.userId as UserId, displayName: row.displayName }],
  );
}

export async function validateGlobalMentions(
  db: MentionSelectExecutor,
  senderId: UserId,
  content: ChatContent,
): Promise<boolean> {
  if (content.mentions.length === 0) return true;

  const ids = [...new Set(content.mentions.map((mention) => mention.userId))];
  const rows = await db
    .select({ userId: authUser.id, username: authUser.username })
    .from(authUser)
    .where(inArray(authUser.id, ids));
  const usernames = new Map(rows.map((row) => [row.userId as UserId, row.username]));

  for (const mention of content.mentions) {
    const username = usernames.get(mention.userId);
    if (mention.userId === senderId || username === undefined || username === null) return false;
    if (content.text.slice(mention.start, mention.start + mention.length) !== `@${username}`)
      return false;
  }
  return true;
}
