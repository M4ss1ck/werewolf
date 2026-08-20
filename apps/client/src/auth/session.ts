import { apiUrl } from "../api/origin.ts";
import { captureAuthToken, clearAuthToken, getAuthToken } from "./token.ts";

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
    const token = getAuthToken();
    const response = await fetch(apiUrl("/api/auth/get-session"), {
      credentials: "include",
      ...(token ? { headers: { Authorization: `Bearer ${token}` } } : {}),
    });
    captureAuthToken(response);
    if (!response.ok) return null;
    return (await response.json()) as Session | null;
  } catch {
    return null;
  }
}

export async function signInWithGoogle() {
  const token = getAuthToken();
  const response = await fetch(apiUrl("/api/auth/sign-in/social"), {
    method: "POST",
    credentials: "include",
    headers: {
      "content-type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ provider: "google", callbackURL: globalThis.location.href }),
  });
  captureAuthToken(response);
  if (!response.ok) throw new Error(`Google sign-in failed (${response.status})`);

  const result = (await response.json()) as { redirect?: boolean; url?: string };
  if (result.redirect && result.url) globalThis.location.href = result.url;
}

export function signOut() {
  const token = getAuthToken();
  return fetch(apiUrl("/api/auth/sign-out"), {
    method: "POST",
    credentials: "include",
    ...(token ? { headers: { Authorization: `Bearer ${token}` } } : {}),
  }).finally(() => clearAuthToken());
}
