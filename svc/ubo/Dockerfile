FROM denoland/deno:alpine-2.2.3@sha256:ac7d8517efbb1e15eb92584e2a0f99f9172761f265f1900dafabf140e918b45f AS base
RUN apk add --no-cache curl
USER deno
WORKDIR /app
COPY . .
RUN deno cache --frozen main.ts

HEALTHCHECK --start-period=3s --start-interval=5s --interval=5m --timeout=10s \
        CMD curl -f "http://localhost:8000/assets.json"

CMD ["deno", "task", "run"]
