FROM denoland/deno:alpine-2.5.1@sha256:904ba915c0b231c88f1309049ecfc1d72fc877afd7a44244f48503b15bad1720 AS base
USER deno

FROM base AS builder

WORKDIR /app
COPY . .
RUN deno cache main.ts

ENTRYPOINT ["deno", "run", "-A", "main.ts"]
