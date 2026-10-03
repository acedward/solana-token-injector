# midnight-esk-decrypt for linux (arm64 on this host; the build follows the daemon's platform).
#
# Build only from the local base image, never pull (plans/00056-solana-token-injector-questions.md Q8):
#   docker build --pull=false -t s00056/decryptor:<run-id> decryptor/
# Extract the binary without an image:
#   docker build --pull=false --output type=local,dest=<dir> decryptor/
#
# No `# syntax=` line on purpose: it would make BuildKit fetch a frontend image. The built-in
# frontend supports `RUN --mount=type=cache`.

FROM oven/bun:1.3.11 AS build

# Same toolchain as rust-toolchain.toml (and midnight-indexer v4.4.0-rc.1).
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
COPY rust-toolchain.toml Cargo.toml Cargo.lock ./
COPY src ./src

RUN --mount=type=cache,id=s00056-cargo-registry,target=/usr/local/cargo/registry \
    --mount=type=cache,id=s00056-cargo-git,target=/usr/local/cargo/git \
    --mount=type=cache,id=s00056-decryptor-target,target=/src/target \
    cargo build --release --locked --bin midnight-esk-decrypt \
 && install -D -m 0755 target/release/midnight-esk-decrypt /out/usr/local/bin/midnight-esk-decrypt

# Final stage: only the binary. It is dynamically linked against the build image's glibc
# (Debian, oven/bun:1.3.11), so run it in an oven/bun:1.3.11-based container, or COPY it into one:
#   COPY --from=<this image> /usr/local/bin/midnight-esk-decrypt /usr/local/bin/
FROM scratch
COPY --from=build /out/ /
ENTRYPOINT ["/usr/local/bin/midnight-esk-decrypt"]
