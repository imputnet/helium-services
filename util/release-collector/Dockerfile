FROM denoland/deno:alpine-2.9.8@sha256:75749604f68aea01d39bead15fd1c86343639e44eb8c58ab051da8a924799d01 AS base
USER deno

FROM base AS builder

WORKDIR /app
COPY . .
RUN deno cache main.ts

ENTRYPOINT ["deno", "run", "-A", "main.ts"]
