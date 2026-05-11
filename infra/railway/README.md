# Aegis on Railway

Two services, no Caddy, no Tor, no Let's Encrypt setup. Railway terminates TLS for each `*.up.railway.app` URL.

Sibling to the self-hosted stack in [`../`](../) — that one stays for VM operators who want full control (Caddy + Tor hidden service + Let's Encrypt). This variant trades that control for zero-ops TLS and managed infra.

> **SSB note** — SSB was a third leg in v1; the browser-bridge pub turned
> out to be unmaintainable and has been removed from this deployment. If
> a Railway project still has a stranded `ssb-pub-volume`, delete it
> manually from the Railway dashboard — nothing in this repo will use it.

## What runs

| Service   | Image / Source                              | Internal port | Volume         |
|-----------|---------------------------------------------|---------------|----------------|
| `conduit` | `matrixconduit/matrix-conduit:latest`       | `6167`        | `conduit_data` |
| `strfry`  | Built from [`../docker/strfry/`](../docker/strfry/) | `7777`        | `strfry_data`  |

The build-from-source service reuses its existing Dockerfile via a relative path in [`docker-compose.yml`](./docker-compose.yml) — no duplication.

## Prereqs

- Railway account ([railway.app](https://railway.app))
- Railway CLI: `npm i -g @railway/cli`
- A GitHub repo with this code pushed up — Railway builds `strfry` from source, and needs a Git remote to pull from.

## Deploy

Railway does NOT consume `docker-compose.yml` via `railway up` the way local Docker Compose does. The compose file documents the topology and bootstraps the project via Railway's Compose importer; you then wire each service to its build source in the dashboard.

```bash
cd /home/kiran/aegis/infra/railway
railway login
railway init                                # creates a Railway project
```

Then in the Railway dashboard:

1. **Drag-and-drop `docker-compose.yml` onto the project canvas.** Railway stages both services + their volumes.
2. For **`conduit`** (uses `image:`) — confirm the staged image `matrixconduit/matrix-conduit:latest` and deploy.
3. For **`strfry`** (uses `build:`) — connect it to your GitHub repo. In the service's **Settings → Build**:
   - **Root Directory**: `infra/docker/strfry`
   - **Dockerfile Path**: `Dockerfile` (relative to that root)
4. For each service, **Settings → Networking → Generate Domain**. Railway issues a `*.up.railway.app` URL and terminates TLS for it.

Note the two URLs Railway hands you — you'll paste them into Vercel next.

## Set the Conduit registration token

Railway dashboard → `conduit` service → **Variables** tab:

```
CONDUIT_REGISTRATION_TOKEN=<same value as AEGIS_MATRIX_REGISTRATION_TOKEN in Vercel>
```

(See [`.env.example`](./.env.example) for the full env contract.)

## Pin `CONDUIT_SERVER_NAME` (recommended)

Conduit reads `server_name` once at first boot and treats it as immutable — changing it later invalidates room state. By default this compose file sets it to `${RAILWAY_PUBLIC_DOMAIN}`, which is fine if you stay on the auto-issued URL forever. If you ever plan to attach a custom domain, set the server name explicitly *before* the first user signs up:

Railway dashboard → `conduit` service → **Variables** tab:

```
AEGIS_CONDUIT_PUBLIC_HOSTNAME=<the hostname you'll use forever>
```

## Set Vercel env vars

Vercel dashboard → Project Settings → Environment Variables. Use the two Railway URLs:

```
AEGIS_MATRIX_HOMESERVER_URL=https://<conduit-railway-url>
NEXT_PUBLIC_AEGIS_MATRIX_HOMESERVER_URL=https://<conduit-railway-url>
```

Note: the strfry relay you deployed is reachable at `wss://<strfry-railway-url>`, but there's no env var wired to swap in a custom Nostr relay yet — clients use the hardcoded public-relay defaults in `src/lib/transport/nostr.ts`. To use your own relay, either edit those defaults or pass a `relays` array to `NostrTransport.connect()` in feature code.

## Done

Visit your Vercel URL. The browser will talk to Vercel for the SSR shell, then directly to your two Railway services for transport.

## Differences from the self-hosted stack

| Concern                  | Self-hosted (`../`)                        | Railway (this dir)                 |
|--------------------------|--------------------------------------------|------------------------------------|
| TLS                      | Caddy + Let's Encrypt (`AEGIS_DOMAIN`)     | Railway terminates per service     |
| Subdomain routing        | Caddy maps `matrix./relay.<domain>`        | Each service has its own URL       |
| Tor hidden service       | `tor` container + Crucible `.onion` fallback | None — Crucible uses clearnet only |
| Per-service env          | `.env` consumed by Compose                 | Set in Railway dashboard, per svc  |
| Cost shape               | Flat VM bill                                | Per-service usage-based            |
