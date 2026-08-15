export interface SessionUser {
  id: string;
  name?: string;
  username?: string | null;
  email?: string;
  image?: string;
}
export interface Session {
  user: SessionUser;
  session?: unknown;
}

export async function getSession(): Promise<Session | null> {
  try {
    const response = await fetch("/api/auth/get-session", { credentials: "include" });
    if (!response.ok) return null;
    return (await response.json()) as Session | null;
  } catch {
    return null;
  }
}

export async function signInWithGoogle() {
  const response = await fetch("/api/auth/sign-in/social", {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ provider: "google", callbackURL: globalThis.location.href }),
  });
  if (!response.ok) throw new Error(`Google sign-in failed (${response.status})`);

  const result = (await response.json()) as { redirect?: boolean; url?: string };
  if (result.redirect && result.url) globalThis.location.href = result.url;
}

export function signOut() {
  return fetch("/api/auth/sign-out", { method: "POST", credentials: "include" });
}
