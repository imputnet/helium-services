FROM rust:1.99.1-alpine3.24@sha256:44819b27be4c97b0e4d7203bd2e02c4820f97700211b6a37fb4c246a2de59383 AS builder
WORKDIR /src
COPY . .
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/src/target \
    cargo build --release --locked && cp target/release/components /

FROM debian:13.8-slim@sha256:8aa5a7bf5a1955bddbe7d74fcdd0b91ab30e74362a8b73af672b0481b35b44a0 AS puffin
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl pkgconf python3 zstd \
    && rm -rf /var/lib/apt/lists/*
COPY build-puffin.sh /
RUN OUT=/out /build-puffin.sh

FROM debian:13.8-slim@sha256:8aa5a7bf5a1955bddbe7d74fcdd0b91ab30e74362a8b73af672b0481b35b44a0
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --system --no-create-home --uid 10001 components \
    && mkdir /data && chown components /data
COPY --from=builder /components /usr/local/bin/
COPY --from=puffin /out/puffin /usr/local/bin/
ENV PUFFIN=/usr/local/bin/puffin
USER components
VOLUME /data

HEALTHCHECK --start-period=3s --start-interval=5s --interval=5m --timeout=10s \
        CMD curl -f "http://localhost:8000/health"

CMD ["components"]
