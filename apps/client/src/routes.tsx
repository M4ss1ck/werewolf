import { type GameId, normalizeGameCode } from "@werewolf/protocol";
import type { GameEntryReferenceInput } from "./api/client.ts";

export type Route =
  | { type: "games" }
  | { type: "create" }
  | { type: "profile" }
  | { type: "chat" }
  | { type: "entry"; reference: GameEntryReferenceInput; rawCode?: string }
  | { type: "game"; id: string }
  | { type: "replay"; id: string };

export function currentRoute(path = `${window.location.pathname}${window.location.search}`): Route {
  const url = new URL(path, "http://werewolf.local");
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts[0] === "join") {
    const rawCode = url.searchParams.get("code") ?? "";
    const code = normalizeGameCode(rawCode);
    return {
      type: "entry",
      reference: { kind: "invitation", code: code ?? rawCode },
      rawCode,
    } as Route;
  }
  if (parts[0] === "games" && parts[1] && parts[2] === "entry") {
    return {
      type: "entry",
      reference: { kind: "public-game", gameId: parts[1] as GameId },
    };
  }
  if (parts[0] === "games" && parts[1] && parts[2] === "replay")
    return { type: "replay", id: parts[1] };
  if (parts[0] === "games" && parts[1]) return { type: "game", id: parts[1] };
  if (parts[0] === "create") return { type: "create" };
  if (parts[0] === "profile") return { type: "profile" };
  if (parts[0] === "chat") return { type: "chat" };
  return { type: "games" };
}

/** Route identity, so re-reading an unchanged URL does not look like a move. */
export function sameRoute(left: Route, right: Route): boolean {
  if (left.type !== right.type) return false;
  if ("id" in left && "id" in right) return left.id === right.id;
  if (left.type === "entry" && right.type === "entry") {
    if (left.reference.kind !== right.reference.kind) return false;
    if (left.reference.kind === "invitation" && right.reference.kind === "invitation")
      return left.reference.code === right.reference.code;
    if (left.reference.kind === "public-game" && right.reference.kind === "public-game")
      return left.reference.gameId === right.reference.gameId;
    return false;
  }
  return true;
}

export function navigate(path: string) {
  window.history.pushState({}, "", path);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

export function replace(path: string) {
  window.history.replaceState({}, "", path);
  window.dispatchEvent(new PopStateEvent("popstate"));
}
