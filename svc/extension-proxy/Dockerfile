FROM denoland/deno:alpine-2.2.3@sha256:ac7d8517efbb1e15eb92584e2a0f99f9172761f265f1900dafabf140e918b45f AS base
USER deno

FROM base AS builder
WORKDIR /app
COPY . .
RUN deno cache main.ts

CMD ["deno", "task", "run"]
