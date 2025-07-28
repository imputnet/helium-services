FROM denoland/deno:alpine-2.4.2@sha256:67a912a84fee096e71b583524aec3a01add461eebccf41a8f190947b6e3c784d AS base
USER deno

FROM base AS builder

WORKDIR /app
COPY . .
RUN deno cache main.ts

ENTRYPOINT ["deno", "run", "-A", "main.ts"]
