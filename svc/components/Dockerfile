FROM rust:1.99.1-alpine3.24@sha256:44819b27be4c97b0e4d7203bd2e02c4820f97700211b6a37fb4c246a2de59383 AS builder
WORKDIR /src
COPY . .
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/src/target \
    cargo build --release --locked && cp target/release/components /

FROM --platform=linux/amd64 debian:trixie-slim AS puffin
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl python3 zstd \
    && rm -rf /var/lib/apt/lists/*
COPY build-puffin.sh /
RUN OUT=/out /build-puffin.sh

FROM alpine:3.24.3@sha256:be2656061b536c1883c4034790e21d0a09c5aaaf51968b89368a3c0371ea2c9a
RUN apk add --no-cache ca-certificates curl gcompat libgcc \
    && adduser -D -H -u 10001 components \
    && mkdir /data && chown components /data
COPY --from=builder /components /usr/local/bin/
COPY --from=puffin /out/puffin /usr/local/bin/
RUN printf a > /tmp/a && printf b > /tmp/b \
    && puffin -puffdiff /tmp/a /tmp/b /tmp/patch \
    && rm /tmp/a /tmp/b /tmp/patch
ENV PUFFIN=/usr/local/bin/puffin
USER components
VOLUME /data

HEALTHCHECK --start-period=3s --start-interval=5s --interval=5m --timeout=10s \
        CMD curl -f "http://localhost:8000/health"

CMD ["components"]
