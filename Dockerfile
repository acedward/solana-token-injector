# solana-token-injector service image: Node 24 + the service + midnight-esk-decrypt (linux; arm64 on
# this host, the build follows the daemon's platform).
#
# Build only from the local base image, never pull (plans/00056-solana-token-injector-questions.md Q8):
#   docker build --pull=false -t s00056/service:<run-id> .
# The harness does this itself (`node harness/cli.mjs up --with-service`, `npm run e2e`), with a tag
# unique per run, and removes the tag on `down`.
#
# No `# syntax=` line on purpose: it would make BuildKit fetch a frontend image. The built-in
# frontend supports `RUN --mount=type=cache`.
#
# Configuration is by environment (master plan I-4); the image holds an empty /app/config.json.
# Required at run time: UPSTREAM (Solana RPC), MIDNIGHT_NETWORK_ID, MIDNIGHT_INDEXER_HTTP (and
# MIDNIGHT_INDEXER_WS unless it is <http url>/ws), PUBLIC_URL (the URL wallets and the page use).
# Data (registrations.json) lives in /data; mount a volume there.

ARG BASE_IMAGE=oven/bun:1.3.11

# ---- stage 1: midnight-esk-decrypt ----------------------------------------------------------------
# Same recipe and BuildKit cache ids as decryptor/Dockerfile (lane B); keep the two in sync.
FROM ${BASE_IMAGE} AS decryptor-build

# Same toolchain as decryptor/rust-toolchain.toml (and midnight-indexer v4.4.0-rc.1).
ARG RUST_TOOLCHAIN=1.95.0
# Parallel rustc jobs; kept below the CPU count so the shared Docker VM keeps memory headroom.
ARG CARGO_BUILD_JOBS=6

RUN apt-get update \
 && apt-get install -y --no-install-recommends build-essential pkg-config curl ca-certificates git \
 && rm -rf /var/lib/apt/lists/*

ENV RUSTUP_HOME=/usr/local/rustup \
    CARGO_HOME=/usr/local/cargo \
    PATH=/usr/local/cargo/bin:$PATH \
    CARGO_BUILD_JOBS=${CARGO_BUILD_JOBS} \
    CARGO_NET_GIT_FETCH_WITH_CLI=true

RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \
      | sh -s -- -y --no-modify-path --profile minimal --default-toolchain ${RUST_TOOLCHAIN} \
 && rustc --version && cargo --version

WORKDIR /src
COPY decryptor/rust-toolchain.toml decryptor/Cargo.toml decryptor/Cargo.lock ./
COPY decryptor/src ./src

RUN --mount=type=cache,id=s00056-cargo-registry,target=/usr/local/cargo/registry \
    --mount=type=cache,id=s00056-cargo-git,target=/usr/local/cargo/git \
    --mount=type=cache,id=s00056-decryptor-target,target=/src/target \
    cargo build --release --locked --bin midnight-esk-decrypt \
 && install -D -m 0755 target/release/midnight-esk-decrypt /out/usr/local/bin/midnight-esk-decrypt

# ---- stage 2: Node 24 (official linux tarball, sha256 pinned from nodejs.org SHASUMS256.txt) ---------
FROM ${BASE_IMAGE} AS node

ARG NODE_VERSION=24.9.0
ARG NODE_SHA256_ARM64=dab232a90169737a48149149dd6707e7fdcbaefbaa94b4871047a38e93db947f
ARG NODE_SHA256_X64=d57d6c28a35785f58f33899a0aa0bfc83f7a8ef4448b6cf3f7d0961efc7b9189
ARG TARGETARCH

RUN apt-get update \
 && apt-get install -y --no-install-recommends curl ca-certificates \
 && rm -rf /var/lib/apt/lists/*

RUN set -eu; \
    case "${TARGETARCH}" in \
      arm64) arch=arm64; sum="${NODE_SHA256_ARM64}" ;; \
      amd64) arch=x64; sum="${NODE_SHA256_X64}" ;; \
      *) echo "unsupported TARGETARCH ${TARGETARCH}" >&2; exit 1 ;; \
    esac; \
    f="node-v${NODE_VERSION}-linux-${arch}.tar.gz"; \
    curl -fsSL --proto '=https' --tlsv1.2 -o "/tmp/${f}" "https://nodejs.org/dist/v${NODE_VERSION}/${f}"; \
    echo "${sum}  /tmp/${f}" | sha256sum -c -; \
    mkdir -p /opt/node; \
    tar -xzf "/tmp/${f}" -C /opt/node --strip-components=1 --no-same-owner; \
    rm "/tmp/${f}"; \
    /opt/node/bin/node --version

# ---- stage 3: production dependencies -------------------------------------------------------------
FROM node AS deps
ENV PATH=/opt/node/bin:$PATH
WORKDIR /app
COPY package.json package-lock.json ./
# --ignore-scripts: the native add-ons in the tree (bigint-buffer, bufferutil, utf-8-validate) have
# JS fallbacks or prebuilt binaries; no compiler in this stage.
RUN --mount=type=cache,id=s00056-npm-cache,target=/root/.npm \
    npm ci --omit=dev --ignore-scripts --no-audit --no-fund

# ---- stage 4: runtime -----------------------------------------------------------------------------
FROM ${BASE_IMAGE}

COPY --from=node /opt/node/bin/node /usr/local/bin/node
COPY --from=decryptor-build /out/usr/local/bin/midnight-esk-decrypt /usr/local/bin/midnight-esk-decrypt

WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json proxy.js ./
COPY src ./src
COPY tokens ./tokens
# The vendored Night Market slice (AA 00059 D1): an ESM bundle the CommonJS service loads with import().
COPY vendor ./vendor

RUN printf '{}\n' > /app/config.json \
 && mkdir -p /data \
 && chown bun:bun /data \
 && node --version \
 && midnight-esk-decrypt --version

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8899 \
    DATA_DIR=/data \
    DECRYPTOR_BIN=/usr/local/bin/midnight-esk-decrypt

# Non-root (the base image's `bun` user, uid 1000).
USER bun
# JSON-RPC, web page and API on 8899; Solana websockets also on 8899 + 1.
EXPOSE 8899 8900
ENTRYPOINT ["node", "proxy.js", "/app/config.json"]
