FROM rust:1.100.0-alpine3.24@sha256:8d0e82abfdf9a38071e07cabc5afba4ddbe077631a80e4e742a760c38beadc33 AS builder
WORKDIR /src
COPY . .
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/src/target \
    cargo build --release --locked && cp target/release/extension-proxy /

FROM alpine:3.24.4@sha256:f59abe656b692d901e184be3445e084786602108599d2a51d229c0f5a48c71bf
RUN apk add --no-cache ca-certificates curl
COPY --from=builder /extension-proxy /usr/local/bin/
USER nobody

HEALTHCHECK --start-period=3s --start-interval=5s --interval=5m --timeout=10s \
        CMD curl -f "http://localhost:8000/health"

CMD ["extension-proxy"]
