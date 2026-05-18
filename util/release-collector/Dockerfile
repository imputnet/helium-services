FROM denoland/deno:alpine-2.7.14@sha256:f36b916d304948316d9af285dba7949be6e17ed56af8b90b389295bcf4326cba AS base
USER deno

FROM base AS builder

WORKDIR /app
COPY . .
RUN deno cache main.ts

ENTRYPOINT ["deno", "run", "-A", "main.ts"]
