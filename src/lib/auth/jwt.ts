import "server-only";

import { SignJWT, jwtVerify } from "jose";

/**
 * Session JWT helpers. Signed with HS256 using AUTH_SECRET. Stored in an
 * HttpOnly cookie — never readable from JS.
 */

const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days

let cachedKey: Uint8Array | null = null;
function getKey(): Uint8Array {
  if (cachedKey) return cachedKey;
  const secret = process.env.AUTH_SECRET;
  if (!secret) throw new Error("AUTH_SECRET is not set");
  cachedKey = new TextEncoder().encode(secret);
  return cachedKey;
}

export type SessionPayload = {
  sub: string; // user id (uuid)
  iat?: number;
  exp?: number;
};

export async function signSession(userId: string): Promise<string> {
  return new SignJWT({})
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(userId)
    .setIssuedAt()
    .setExpirationTime(`${SESSION_TTL_SECONDS}s`)
    .sign(getKey());
}

export async function verifySession(token: string): Promise<SessionPayload> {
  const { payload } = await jwtVerify(token, getKey());
  if (typeof payload.sub !== "string") {
    throw new Error("invalid session payload");
  }
  return payload as SessionPayload;
}

export const SESSION_COOKIE_NAME = "aegis_session";
export { SESSION_TTL_SECONDS };
