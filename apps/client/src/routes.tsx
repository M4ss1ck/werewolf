export type Route =
  | { type: "games" }
  | { type: "game"; id: string }
  | { type: "replay"; id: string };

export function currentRoute(pathname = window.location.pathname): Route {
  const parts = pathname.split("/").filter(Boolean);
  if (parts[0] === "games" && parts[1] && parts[2] === "replay")
    return { type: "replay", id: parts[1] };
  if (parts[0] === "games" && parts[1]) return { type: "game", id: parts[1] };
  return { type: "games" };
}

export function navigate(path: string) {
  window.history.pushState({}, "", path);
  window.dispatchEvent(new PopStateEvent("popstate"));
}
