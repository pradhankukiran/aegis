# Build strfry from upstream source.
# We deliberately build from source rather than using a community image — we want
# auditable provenance for a portfolio relay. Multi-stage so the runtime image
# stays small (~200 MB) and only contains the binary + its shared libs.
#
# Upstream: https://github.com/hoytech/strfry
# License: GPL-3.0

# ---- Builder stage --------------------------------------------------------------
FROM ubuntu:24.04 AS builder

ARG STRFRY_REF=master

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates \
        git \
        g++ \
        make \
        pkg-config \
        libssl-dev \
        zlib1g-dev \
        liblmdb-dev \
        libflatbuffers-dev \
        libsecp256k1-dev \
        libzstd-dev \
        libyaml-perl \
        libtemplate-perl \
        libregexp-grammars-perl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /src
RUN git clone https://github.com/hoytech/strfry.git . \
    && git checkout "${STRFRY_REF}" \
    && git submodule update --init \
    && make setup-golpe \
    && make -j"$(nproc)"

# ---- Runtime stage --------------------------------------------------------------
FROM ubuntu:24.04 AS runtime

ENV DEBIAN_FRONTEND=noninteractive

# Runtime libraries only (no -dev packages, no toolchain).
RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates \
        bash \
        libssl3 \
        zlib1g \
        liblmdb0 \
        libflatbuffers2 \
        libsecp256k1-1 \
        libzstd1 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY --from=builder /src/strfry /app/strfry
COPY strfry.conf /etc/strfry.conf

# DB dir lives at /app/strfry-db so the strfry.conf default `db = "./strfry-db/"` resolves.
RUN mkdir -p /app/strfry-db

EXPOSE 7777

CMD ["/app/strfry", "--config", "/etc/strfry.conf", "relay"]
