export type Route =
  | { type: "games" }
  | { type: "create" }
  | { type: "profile" }
  | { type: "chat" }
  | { type: "game"; id: string }
  | { type: "replay"; id: string };

export function currentRoute(pathname = window.location.pathname): Route {
  const parts = pathname.split("/").filter(Boolean);
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
  const id = (route: Route) => ("id" in route ? route.id : undefined);
  return left.type === right.type && id(left) === id(right);
}

export function navigate(path: string) {
  window.history.pushState({}, "", path);
  window.dispatchEvent(new PopStateEvent("popstate"));
}
