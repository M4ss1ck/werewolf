export interface SessionUser {
  id: string;
  name?: string;
  email?: string;
  image?: string;
}
export interface Session {
  user: SessionUser;
  session?: unknown;
}

export async function getSession(): Promise<Session | null> {
  const response = await fetch("/api/auth/get-session", { credentials: "include" });
  if (!response.ok) return null;
  return (await response.json()) as Session | null;
}

export function signInWithGoogle() {
  return fetch("/api/auth/sign-in/social", {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ provider: "google", callbackURL: window.location.href }),
  });
}

export function signOut() {
  return fetch("/api/auth/sign-out", { method: "POST", credentials: "include" });
}
