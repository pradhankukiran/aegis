# Aegis SSB pub.
# Runs ssb-server (Node) as the long-lived feed/replication peer.
# Browsers do NOT import ssb-browser-core (abandoned alpha) — they connect over a
# WebSocket bridge to this pub via the ssb-ws plugin, exposed at :8989.
#
# See aegis-networks-decisions.md §SSB for the rationale.

FROM node:22-alpine

# Some legacy SSB native deps need a build toolchain at install time
# (sodium-native pulls libsodium at npm-install). python3 + make + g++ are
# enough; we drop the toolchain after install to keep the image small.
RUN apk add --no-cache --virtual .build-deps \
        python3 \
        make \
        g++ \
        bash \
        git

WORKDIR /app

COPY package.json package.json
RUN npm install --omit=dev --no-audit --no-fund

COPY index.js index.js

# Strip the build toolchain — keep wget (busybox provides it) for the healthcheck.
RUN apk del .build-deps

# ssb-ws plugin port (native SHS+muxrpc-over-WS, used by Node SSB peers)
EXPOSE 8989

# muxrpc/secret-handshake port (peer-to-peer SSB)
EXPOSE 8008

# Aegis JSON-WS bridge (browser <-> pub, see src/lib/transport/ssb.ts)
EXPOSE 8990

CMD ["node", "index.js"]
