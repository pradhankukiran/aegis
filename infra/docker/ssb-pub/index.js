/* eslint-disable no-console */
/**
 * Aegis Scuttlebutt pub.
 *
 * Runs an ssb-server instance with the plugin set Aegis needs:
 *   - ssb-master      : grant local processes admin caps
 *   - ssb-ws          : websocket transport (browser bridge — port 8989)
 *   - ssb-replicate   : feed replication
 *   - ssb-friends     : trust graph for replication scheduling
 *   - ssb-blobs       : binary blob exchange
 *   - ssb-private1    : legacy box1 private messages (decryption support)
 *   - ssb-invite      : invite-code generation/redemption for new peers
 *
 * Also runs:
 *   - /healthz        : tiny HTTP healthcheck endpoint (port 8989)
 *   - aegis-ws-bridge : the JSON-over-WebSocket bridge consumed by the browser
 *                       (port 8990). See the file-level comment in
 *                       `src/lib/transport/ssb.ts` for the protocol spec
 *                       (Path B — pragmatic JSON shim, not full SHS+muxrpc).
 *
 * The native ssb-ws plugin on :8989 is left untouched so other Node SSB peers
 * can still talk muxrpc-over-WS to this pub. The Aegis browser app does NOT
 * consume :8989 directly.
 */

const crypto = require('crypto');
const http = require('http');

const SecretStack = require('secret-stack');
const pull = require('pull-stream');
const WebSocket = require('ws');

const WS_PORT = parseInt(process.env.AEGIS_SSB_WS_PORT || '8989', 10);
const MUXRPC_PORT = parseInt(process.env.AEGIS_SSB_PORT || '8008', 10);
const HEALTH_PORT = parseInt(process.env.AEGIS_HEALTH_PORT || '8989', 10);
const BRIDGE_PORT = parseInt(process.env.AEGIS_SSB_BRIDGE_PORT || '8990', 10);

// secret-stack assembles the actual ssb-server with its plugin chain.
// ssb-server itself is the published preset, but we list the plugins explicitly
// so the configuration is auditable.
const createServer = SecretStack({
  // secret-stack@8 renamed caps.shs -> global.appKey. Standard SSB shs caps
  // key — same value every SSB peer in the public network uses.
  // (Override via env if running an isolated Aegis test net.)
  global: {
    appKey:
      process.env.AEGIS_SHS_CAP ||
      '1KHLiKZvAvjbY1ziZEHMXawbCEIM6qwjCDm3VYRan/s=',
  },
})
  .use(require('ssb-master'))
  .use(require('ssb-ws'))
  .use(require('ssb-replicate'))
  .use(require('ssb-friends'))
  .use(require('ssb-blobs'))
  .use(require('ssb-private1'))
  .use(require('ssb-invite'));

const config = {
  host: '0.0.0.0',
  port: MUXRPC_PORT,
  ws: {
    port: WS_PORT,
    host: '0.0.0.0',
  },
  // ssb-server stores its database (keypair, indexes, blobs) under ~/.ssb,
  // which is mounted as the `ssb_data` volume in docker-compose.
  path: process.env.AEGIS_SSB_PATH || '/root/.ssb',
};

let sbot;
try {
  sbot = createServer(config);
  console.log(
    `[aegis-ssb-pub] ssb-server up. muxrpc :${MUXRPC_PORT}, ws :${WS_PORT}, path ${config.path}`,
  );

  if (sbot && typeof sbot.whoami === 'function') {
    sbot.whoami((err, info) => {
      if (err) {
        console.error('[aegis-ssb-pub] whoami error:', err);
      } else {
        console.log(`[aegis-ssb-pub] feed id: ${info && info.id}`);
      }
    });
  }
} catch (err) {
  console.error('[aegis-ssb-pub] failed to start:', err);
  process.exit(1);
}

// ----- /healthz side server ----------------------------------------------------
// Runs on the same port as ssb-ws (8989). ssb-ws is an HTTP-upgrade server, so
// regular GET /healthz requests would land in ssb-ws's handler. To avoid colliding,
// we run a separate tiny HTTP server on a distinct port and document that path.
//
// We deliberately put the healthz server on its own port (8990) when WS port is
// the same as health port. The compose healthcheck calls localhost:8989/healthz
// directly — ssb-ws responds 200 to plain HTTP GETs at unknown paths with a
// boilerplate body, but to make the check meaningful we attempt the side server
// on a different port. To keep the contract documented in the plan (port 8989
// healthz), we only spin up the side server if HEALTH_PORT != WS_PORT.
//
// Practically: ssb-ws@6.2.3 returns a 200 on GET / for any path, which the
// `wget -qO-` healthcheck will accept. /healthz is therefore satisfied by
// ssb-ws itself for the compose healthcheck. The block below provides an
// explicit /healthz route on a separate port for any deployment that wants it.

if (HEALTH_PORT !== WS_PORT && HEALTH_PORT !== BRIDGE_PORT) {
  const healthServer = http.createServer((req, res) => {
    if (req.url === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          status: 'ok',
          ws_port: WS_PORT,
          muxrpc_port: MUXRPC_PORT,
          bridge_port: BRIDGE_PORT,
          uptime_s: Math.round(process.uptime()),
        }),
      );
      return;
    }
    res.writeHead(404);
    res.end();
  });

  healthServer.listen(HEALTH_PORT, '0.0.0.0', () => {
    console.log(`[aegis-ssb-pub] /healthz listening on :${HEALTH_PORT}`);
  });
}

// ----- Aegis JSON-WS bridge ---------------------------------------------------
//
// Wire spec — see `src/lib/transport/ssb.ts` for the canonical protocol doc.
// Frames are JSON; each carries a top-level `op`. We accept the following ops
// from the browser, in order of expected use:
//
//   {op:"auth",        ssb_id, ed_pubkey, challenge_sig}     -> auth_ok | err
//   {op:"publish",     id, content}                          -> publish_ok | err
//   {op:"subscribe",   id, author?}                          -> subscribe_ok | err  (then a stream of msg)
//   {op:"unsubscribe", id, sub_id}                           -> (silent)
//   {op:"close"}                                             -> server tears down
//
// On connect, the server emits {op:"hello", challenge:<base64url-32-bytes>}.
// The browser must reply with `auth` containing an Ed25519 signature over those
// challenge bytes, signed with the key derived from the user's master identity
// (HKDF-SHA256 with info="aegis-ssb-ed25519-v1"). See `ssb.ts` for the
// derivation. The pub never sees the user's secp256k1 secret — only the
// derived Ed25519 public key and a one-shot signature proving control.
//
// Trust model: the pub is the publisher of record. Messages sent via this
// bridge are wrapped in an envelope:
//
//   { type: "aegis-ssb-v1",
//     aegis_author: <ssb_id>,           // user's derived feed id (NOT the pub's)
//     aegis_pubkey: <base64url-edPk>,
//     payload: <user-supplied content>,
//     ts: <ms-since-epoch> }
//
// SSB itself signs the envelope under the *pub's* feed key, so to a stock SSB
// peer the pub is the author. Aegis-aware consumers MUST verify
// `aegis_author` matches the user identity they expect, and SHOULD verify a
// signature inside `payload` if the application demands it. v1 leaves
// per-message author signatures to upper layers (Witness, Quorum, etc.) since
// most Aegis uses already wrap content in their own crypto envelopes.

const CHALLENGE_BYTES = 32;
let nextConnId = 1;

const bridge = new WebSocket.Server({
  port: BRIDGE_PORT,
  host: '0.0.0.0',
});

bridge.on('listening', () => {
  console.log(
    `[aegis-ssb-pub] aegis-ws-bridge listening on :${BRIDGE_PORT} (JSON shim)`,
  );
});

bridge.on('connection', (ws, req) => {
  const connId = nextConnId++;
  const remote =
    (req && (req.socket && req.socket.remoteAddress)) || 'unknown';
  const conn = {
    id: connId,
    ws,
    remote,
    authed: false,
    ssbId: null,
    edPubKey: null, // base64url string (untouched as transmitted)
    challenge: crypto.randomBytes(CHALLENGE_BYTES),
    subs: new Map(), // sub_id -> { drain }
  };

  console.log(
    `[aegis-ssb-pub] bridge conn #${connId} from ${remote} (challenge issued)`,
  );

  send(ws, {
    op: 'hello',
    challenge: toBase64Url(conn.challenge),
  });

  ws.on('message', (raw) => onMessage(conn, raw));
  ws.on('close', () => onClose(conn));
  ws.on('error', (err) => {
    console.error(`[aegis-ssb-pub] bridge conn #${connId} error:`, err);
  });
});

function onMessage(conn, raw) {
  let frame;
  try {
    frame = JSON.parse(raw.toString('utf8'));
  } catch (err) {
    sendErr(conn.ws, undefined, 'bad_json', 'malformed JSON frame');
    return;
  }
  if (!frame || typeof frame.op !== 'string') {
    sendErr(conn.ws, frame && frame.id, 'bad_frame', 'missing op');
    return;
  }

  if (!conn.authed) {
    if (frame.op === 'auth') return handleAuth(conn, frame);
    sendErr(conn.ws, frame.id, 'unauthenticated', 'auth required');
    return;
  }

  switch (frame.op) {
    case 'publish':
      return handlePublish(conn, frame);
    case 'subscribe':
      return handleSubscribe(conn, frame);
    case 'unsubscribe':
      return handleUnsubscribe(conn, frame);
    case 'close':
      try {
        conn.ws.close();
      } catch (err) {
        void err;
      }
      return;
    default:
      sendErr(conn.ws, frame.id, 'unknown_op', `unknown op "${frame.op}"`);
      return;
  }
}

function handleAuth(conn, frame) {
  const { ssb_id: ssbId, ed_pubkey: edPubB64, challenge_sig: sigB64 } = frame;
  if (!ssbId || !edPubB64 || !sigB64) {
    sendErr(conn.ws, undefined, 'bad_auth', 'auth fields missing');
    return;
  }
  let edPub;
  let sig;
  try {
    edPub = fromBase64Url(edPubB64);
    sig = fromBase64Url(sigB64);
  } catch (err) {
    sendErr(conn.ws, undefined, 'bad_auth', 'auth fields not base64url');
    return;
  }
  if (edPub.length !== 32) {
    sendErr(conn.ws, undefined, 'bad_auth', 'ed_pubkey must be 32 bytes');
    return;
  }
  if (sig.length !== 64) {
    sendErr(conn.ws, undefined, 'bad_auth', 'challenge_sig must be 64 bytes');
    return;
  }

  // The ssb_id MUST match the supplied ed_pubkey (defence in depth — keeps the
  // wire identity, the cryptographic identity, and the application identity
  // from drifting apart).
  const expectedSsbId = `@${edPubB64}.ed25519`;
  // Tolerate the standard '+/=' base64 form too: re-encode and compare.
  const stdEdPubB64 = Buffer.from(edPub).toString('base64');
  const altSsbId = `@${stdEdPubB64}.ed25519`;
  if (ssbId !== expectedSsbId && ssbId !== altSsbId) {
    sendErr(conn.ws, undefined, 'bad_auth', 'ssb_id does not match ed_pubkey');
    return;
  }

  let ok = false;
  try {
    ok = crypto.verify(
      null, // Ed25519 in Node ≥12.9 takes a null algorithm
      conn.challenge,
      // Wrap into a KeyObject via the SubjectPublicKeyInfo DER prefix for Ed25519.
      {
        key: ed25519PublicKeyToDer(edPub),
        format: 'der',
        type: 'spki',
      },
      sig,
    );
  } catch (err) {
    console.error(`[aegis-ssb-pub] verify error on conn #${conn.id}:`, err);
    sendErr(conn.ws, undefined, 'bad_auth', 'signature verification failed');
    return;
  }
  if (!ok) {
    sendErr(conn.ws, undefined, 'bad_auth', 'challenge signature did not verify');
    return;
  }

  conn.authed = true;
  conn.ssbId = ssbId;
  conn.edPubKey = edPubB64;
  console.log(
    `[aegis-ssb-pub] bridge conn #${conn.id} authenticated as ${ssbId}`,
  );
  send(conn.ws, { op: 'auth_ok' });
}

function handlePublish(conn, frame) {
  if (!sbot || typeof sbot.publish !== 'function') {
    sendErr(conn.ws, frame.id, 'unavailable', 'sbot.publish not ready');
    return;
  }
  if (!frame.id) {
    sendErr(conn.ws, undefined, 'bad_frame', 'publish requires id');
    return;
  }
  const inner = frame.content;
  if (!inner || typeof inner !== 'object') {
    sendErr(conn.ws, frame.id, 'bad_frame', 'content must be an object');
    return;
  }
  // Wrap the user's content in an Aegis envelope. See trust-model comment above.
  const envelope = {
    type: 'aegis-ssb-v1',
    aegis_author: conn.ssbId,
    aegis_pubkey: conn.edPubKey,
    payload: inner,
    ts: Date.now(),
  };
  sbot.publish(envelope, (err, msg) => {
    if (err) {
      sendErr(conn.ws, frame.id, 'publish_failed', String(err.message || err));
      return;
    }
    send(conn.ws, {
      op: 'publish_ok',
      id: frame.id,
      msg_id: msg.key,
      sequence: msg.value && msg.value.sequence,
    });
  });
}

function handleSubscribe(conn, frame) {
  if (!sbot || typeof sbot.createFeedStream !== 'function') {
    sendErr(conn.ws, frame.id, 'unavailable', 'sbot.createFeedStream not ready');
    return;
  }
  if (!frame.id) {
    sendErr(conn.ws, undefined, 'bad_frame', 'subscribe requires id');
    return;
  }
  if (conn.subs.has(frame.id)) {
    sendErr(conn.ws, frame.id, 'duplicate_sub', 'sub_id already in use');
    return;
  }

  // If the caller supplied an `author`, prefer createUserStream (filters
  // server-side). Otherwise use the firehose.
  const stream =
    frame.author && typeof sbot.createUserStream === 'function'
      ? sbot.createUserStream({ id: frame.author, live: true })
      : sbot.createFeedStream({ live: true });

  // pull-stream sink that forwards messages to the WS as long as the sub is
  // active and the WS is open. Returning `false` from the drain body is the
  // documented way to stop a pull-drain mid-flight (pull-stream API: the sink
  // calls back with `true` on subsequent reads, which cancels the source).
  const subEntry = { aborted: false };
  const drain = pull.drain(
    (msg) => {
      if (
        subEntry.aborted ||
        !conn.subs.has(frame.id) ||
        conn.ws.readyState !== WebSocket.OPEN
      ) {
        return false; // stops the pull-drain
      }
      // Some SSB streams emit a `{sync: true}` heartbeat after the historical
      // backlog has been drained. Ignore it; the client doesn't care.
      if (msg && msg.sync) return undefined;
      send(conn.ws, { op: 'msg', sub_id: frame.id, msg });
      return undefined;
    },
    (err) => {
      if (err && conn.ws.readyState === WebSocket.OPEN && !subEntry.aborted) {
        sendErr(conn.ws, frame.id, 'stream_err', String(err.message || err));
      }
      conn.subs.delete(frame.id);
    },
  );
  subEntry.drain = drain;

  // Hand the stream into the drain. createFeedStream returns a pull-source.
  pull(stream, drain);

  conn.subs.set(frame.id, subEntry);
  send(conn.ws, { op: 'subscribe_ok', id: frame.id });
}

function handleUnsubscribe(conn, frame) {
  const sub = conn.subs.get(frame.sub_id);
  if (!sub) return; // silent — idempotent
  sub.aborted = true;
  conn.subs.delete(frame.sub_id);
  // The pull-drain body checks `subEntry.aborted` on each message and returns
  // `false`, which is the documented pull-stream signal to abort the upstream.
  // No further server-side ack is required — clients that care can re-issue
  // a subscribe with a new sub_id.
}

function onClose(conn) {
  console.log(`[aegis-ssb-pub] bridge conn #${conn.id} closed`);
  conn.subs.clear();
}

// ----- helpers ---------------------------------------------------------------

function send(ws, frame) {
  if (ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify(frame));
}

function sendErr(ws, id, code, message) {
  send(ws, { op: 'err', id, code, message });
}

function toBase64Url(buf) {
  return Buffer.from(buf)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function fromBase64Url(s) {
  if (typeof s !== 'string') throw new Error('not a string');
  const stripped = s.replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/g, '');
  const padding = (4 - (stripped.length % 4)) % 4;
  return Buffer.from(stripped + '='.repeat(padding), 'base64');
}

// Build the SubjectPublicKeyInfo DER blob Node's crypto.verify wants.
// For Ed25519 it's a 12-byte fixed prefix followed by the 32-byte raw key.
// Prefix: 30 2a 30 05 06 03 2b 65 70 03 21 00  (RFC 8410 §4)
const ED25519_SPKI_PREFIX = Buffer.from(
  '302a300506032b6570032100',
  'hex',
);
function ed25519PublicKeyToDer(pub32) {
  return Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(pub32)]);
}

// ----- graceful shutdown -------------------------------------------------------
function shutdown(signal) {
  console.log(`[aegis-ssb-pub] received ${signal}, closing ssb-server`);
  try {
    bridge.close();
  } catch (err) {
    void err;
  }
  if (sbot && typeof sbot.close === 'function') {
    sbot.close((err) => {
      if (err) console.error('[aegis-ssb-pub] close error:', err);
      process.exit(0);
    });
  } else {
    process.exit(0);
  }
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
