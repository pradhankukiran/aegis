import type { NextRequest } from "next/server";

/**
 * POST /api/matrix/register
 *
 * Server-side proxy for Matrix UIA registration with the homeserver's
 * `m.login.registration_token` flow. The registration token lives ONLY in
 * the server-side `AEGIS_MATRIX_REGISTRATION_TOKEN` env var so it's never
 * bundled into the client JS (SEC-004).
 *
 * Why: previously the token was `NEXT_PUBLIC_AEGIS_MATRIX_REGISTRATION_TOKEN`
 * which is inlined into the client bundle by Next.js. Anyone with the
 * deployment URL could read the JS and mint arbitrary Matrix accounts on
 * the Aegis homeserver. With this route the client only ever sees the
 * `{accessToken, deviceId, mxid}` for its own pubkey-derived localpart.
 *
 * Body (required):
 *   { username: string, password: string }
 *
 *   - `username` is the pubkey-derived localpart the client wants to claim
 *     (see `matrix.ts#deriveLocalpart`). The server forwards it verbatim;
 *     the homeserver enforces the actual uniqueness constraint.
 *   - `password` is the random password the client wants to associate with
 *     the account. We forward it unchanged. Aegis itself never logs in
 *     with this password — the registration response carries an access
 *     token, which is what we actually use. (The homeserver still requires
 *     a password on the wire for the registration flow, so we accept and
 *     forward one.)
 *
 * Response (200):
 *   { accessToken: string, deviceId: string, mxid: string }
 *
 * Response (503):
 *   { error: "matrix-register-not-configured", message: string }
 *
 * Response (400, 401, 502 etc.):
 *   { error: string, message?: string, status?: number }
 *
 * The homeserver URL comes from `AEGIS_MATRIX_HOMESERVER_URL` (server-only).
 * If unset, we return 503 — there's no sensible default.
 */

const HOMESERVER_ENV = "AEGIS_MATRIX_HOMESERVER_URL";
const TOKEN_ENV = "AEGIS_MATRIX_REGISTRATION_TOKEN";

/**
 * Reasonable upper bound for the username (localpart). Matrix's hard cap
 * is 255 chars; we use 100 because pubkey-derived localparts are at most
 * 64 hex chars in practice. This is shape validation, not a security
 * boundary.
 */
const MAX_USERNAME_LEN = 100;
/** Likewise a generous cap on the password we're forwarding. */
const MAX_PASSWORD_LEN = 200;

type RegisterBody = {
  username: string;
  password: string;
};

function validateBody(raw: unknown): RegisterBody | { error: string } {
  if (!raw || typeof raw !== "object") {
    return { error: "body must be a JSON object" };
  }
  const obj = raw as Record<string, unknown>;
  const username = obj.username;
  const password = obj.password;
  if (typeof username !== "string" || username.length === 0) {
    return { error: "username must be a non-empty string" };
  }
  if (typeof password !== "string" || password.length === 0) {
    return { error: "password must be a non-empty string" };
  }
  if (username.length > MAX_USERNAME_LEN) {
    return { error: `username too long (>${MAX_USERNAME_LEN} chars)` };
  }
  if (password.length > MAX_PASSWORD_LEN) {
    return { error: `password too long (>${MAX_PASSWORD_LEN} chars)` };
  }
  // Matrix localparts: `[a-z0-9._=/+-]+` per the Spec; we accept the
  // most-restrictive subset Aegis ever sends (hex). The homeserver still
  // re-validates.
  if (!/^[a-z0-9._=/+\-]+$/i.test(username)) {
    return { error: "username contains disallowed characters" };
  }
  return { username, password };
}

function trimTrailingSlash(s: string): string {
  return s.endsWith("/") ? s.slice(0, -1) : s;
}

function parseHomeserverDomain(homeserver: string): string | null {
  try {
    return new URL(homeserver).hostname;
  } catch {
    return null;
  }
}

export async function POST(req: NextRequest) {
  const homeserverRaw = process.env[HOMESERVER_ENV];
  const token = process.env[TOKEN_ENV];

  if (!token) {
    return Response.json(
      {
        error: "matrix-register-not-configured",
        message: `${TOKEN_ENV} env var not set`,
      },
      { status: 503 },
    );
  }
  if (!homeserverRaw) {
    return Response.json(
      {
        error: "matrix-register-not-configured",
        message: `${HOMESERVER_ENV} env var not set`,
      },
      { status: 503 },
    );
  }
  const homeserver = trimTrailingSlash(homeserverRaw);
  const domain = parseHomeserverDomain(homeserver);
  if (!domain) {
    return Response.json(
      {
        error: "matrix-register-not-configured",
        message: `${HOMESERVER_ENV} is not a valid URL`,
      },
      { status: 503 },
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const parsed = validateBody(body);
  if ("error" in parsed) {
    return Response.json({ error: parsed.error }, { status: 400 });
  }
  const { username, password } = parsed;

  const registerUrl = `${homeserver}/_matrix/client/v3/register`;

  // Step 1 — bare register call to elicit a UIA session id (and the flows
  // the homeserver wants).
  let probeBody: { session?: string; access_token?: string; device_id?: string };
  try {
    const probe = await fetch(registerUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    });
    if (probe.status === 401) {
      probeBody = (await probe.json()) as { session?: string };
    } else if (probe.ok) {
      // Some homeservers register without UIA (open registration). Just
      // return the credentials we already have.
      const open = (await probe.json()) as {
        access_token?: string;
        device_id?: string;
        user_id?: string;
      };
      if (!open.access_token) {
        return Response.json(
          {
            error: "matrix-upstream-bad-response",
            message: "homeserver returned no access_token on open registration",
          },
          { status: 502 },
        );
      }
      return Response.json({
        accessToken: open.access_token,
        deviceId: open.device_id ?? "",
        mxid: open.user_id ?? `@${username}:${domain}`,
      });
    } else {
      let detail: unknown = null;
      try {
        detail = await probe.json();
      } catch {
        /* ignore */
      }
      return Response.json(
        {
          error: "matrix-upstream-error",
          message: `homeserver probe failed (${probe.status})`,
          status: probe.status,
          detail,
        },
        { status: 502 },
      );
    }
  } catch (err) {
    return Response.json(
      {
        error: "matrix-upstream-unreachable",
        message: err instanceof Error ? err.message : String(err),
      },
      { status: 502 },
    );
  }

  const session = probeBody.session;
  if (!session) {
    return Response.json(
      {
        error: "matrix-upstream-bad-response",
        message: "homeserver did not return a UIA session id",
      },
      { status: 502 },
    );
  }

  // Step 2 — submit the registration_token auth dict.
  let finalRes: Response;
  try {
    finalRes = await fetch(registerUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username,
        password,
        auth: {
          type: "m.login.registration_token",
          token,
          session,
        },
      }),
    });
  } catch (err) {
    return Response.json(
      {
        error: "matrix-upstream-unreachable",
        message: err instanceof Error ? err.message : String(err),
      },
      { status: 502 },
    );
  }

  if (!finalRes.ok) {
    let detail: unknown = null;
    try {
      detail = await finalRes.json();
    } catch {
      /* ignore */
    }
    return Response.json(
      {
        error: "matrix-register-failed",
        message: `registration completion failed (${finalRes.status})`,
        status: finalRes.status,
        detail,
      },
      { status: finalRes.status === 401 ? 401 : 502 },
    );
  }
  const okBody = (await finalRes.json()) as {
    access_token?: string;
    device_id?: string;
    user_id?: string;
  };
  if (!okBody.access_token) {
    return Response.json(
      {
        error: "matrix-upstream-bad-response",
        message: "homeserver returned no access_token after UIA",
      },
      { status: 502 },
    );
  }

  return Response.json({
    accessToken: okBody.access_token,
    deviceId: okBody.device_id ?? "",
    mxid: okBody.user_id ?? `@${username}:${domain}`,
  });
}
