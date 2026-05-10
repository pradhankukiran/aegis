import "server-only";

import type { NextRequest } from "next/server";

/**
 * CSRF defence for state-changing routes.
 *
 * Compares the request's `Origin` (or `Referer` fallback) against the
 * configured app URL. Browsers always set one of these on cross-site
 * fetches, so a mismatch means the request did not come from our app.
 *
 * Returns true on same-origin, false otherwise. Returns false (fail-closed)
 * when NEXT_PUBLIC_APP_URL is unset or unparseable.
 */
export function isSameOrigin(req: NextRequest): boolean {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL;
  if (!appUrl) return false;

  let expectedOrigin: string;
  try {
    expectedOrigin = new URL(appUrl).origin;
  } catch {
    return false;
  }

  const origin = req.headers.get("origin");
  if (origin) {
    return origin === expectedOrigin;
  }

  // Older clients (or some non-browser callers) don't set Origin; fall back
  // to Referer. Reject if neither header is present — fail-closed.
  const referer = req.headers.get("referer");
  if (!referer) return false;
  try {
    return new URL(referer).origin === expectedOrigin;
  } catch {
    return false;
  }
}

/**
 * Returns a 403 Response if the request fails the same-origin check,
 * otherwise null. Use at the top of POST handlers:
 *
 *   const csrf = assertSameOrigin(req);
 *   if (csrf) return csrf;
 */
export function assertSameOrigin(req: NextRequest): Response | null {
  if (isSameOrigin(req)) return null;
  return Response.json({ error: "forbidden" }, { status: 403 });
}
