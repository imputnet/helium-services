FROM denoland/deno:alpine-2.5.1@sha256:904ba915c0b231c88f1309049ecfc1d72fc877afd7a44244f48503b15bad1720 AS base
RUN apk add --no-cache curl
USER deno
WORKDIR /app
COPY . .
RUN deno cache --frozen main.ts

HEALTHCHECK --start-period=3s --start-interval=5s --interval=5m --timeout=10s \
        CMD curl -f "http://localhost:8000/assets.json"

CMD ["deno", "task", "run"]
